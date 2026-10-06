[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$script:AsanaApiRoot = 'https://app.asana.com/api/1.0'
$script:AsanaToken = $null

function Invoke-AsanaApi {
  param([Parameter(Mandatory = $true)][string]$Uri)

  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      return Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ Authorization = "Bearer $script:AsanaToken" } -ErrorAction Stop
    } catch {
      $statusCode = 0
      try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
      if (($statusCode -ne 429 -and $statusCode -lt 500) -or $attempt -eq 4) {
        throw "Asana API request failed (HTTP $statusCode). Check the token, project ID, and API permissions."
      }
      $delay = [Math]::Min([Math]::Pow(2, $attempt + 1), 30)
      try {
        $retryAfter = [int]$_.Exception.Response.Headers['Retry-After']
        if ($retryAfter -gt 0) { $delay = [Math]::Min($retryAfter, 60) }
      } catch {}
      Start-Sleep -Seconds $delay
    }
  }
}

function Get-AsanaItems {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Fields
  )

  $items = New-Object 'System.Collections.Generic.List[object]'
  $offset = $null
  do {
    $query = "opt_fields=$([uri]::EscapeDataString($Fields))&limit=100"
    if ($offset) { $query += "&offset=$([uri]::EscapeDataString($offset))" }
    $response = Invoke-AsanaApi -Uri "$script:AsanaApiRoot/$Path`?$query"
    foreach ($item in @($response.data)) {
      if ($null -ne $item) { $items.Add($item) | Out-Null }
    }
    $offset = if ($response.next_page) { [string]$response.next_page.offset } else { $null }
  } while ($offset)
  return ,$items.ToArray()
}

function Get-AsanaAttachmentRecords {
  param(
    [Parameter(Mandatory = $true)]$Task,
    [Parameter(Mandatory = $true)][string]$AttachmentsDirectory
  )

  $records = New-Object 'System.Collections.Generic.List[object]'
  try {
    $attachments = Get-AsanaItems -Path "tasks/$($Task.gid)/attachments" `
      -Fields 'gid,name,created_at,download_url,size'
  } catch {
    Write-Warning "Could not list attachments for task '$($Task.name)'; task data will still be exported."
    return ,$records.ToArray()
  }

  foreach ($attachment in $attachments) {
    $localFile = $null
    $originalName = [System.IO.Path]::GetFileName([string]$attachment.name)
    $safeName = ($originalName -replace '[<>:"/\\|?*]', '_').Trim()
    if ($safeName.Length -gt 100) { $safeName = $safeName.Substring(0, 100) }
    if (-not $safeName) { $safeName = 'asana-attachment' }
    $fileName = "{0}-{1}-{2}" -f $Task.gid, $attachment.gid, $safeName
    $filePath = Join-Path $AttachmentsDirectory $fileName
    $isTooLarge = $attachment.size -and [long]$attachment.size -gt 20MB

    if ($attachment.download_url -and -not $isTooLarge) {
      try {
        Invoke-WebRequest -Uri ([string]$attachment.download_url) -OutFile $filePath -UseBasicParsing -ErrorAction Stop
        $localFile = $fileName
      } catch {
        Remove-Item -LiteralPath $filePath -Force -ErrorAction SilentlyContinue
        Write-Warning "Could not download attachment '$originalName'; it will be listed without a local file."
      }
    } elseif ($isTooLarge) {
      Write-Warning "Attachment '$originalName' exceeds TaskFlow's 20 MB per-file limit and was not downloaded."
    }

    $records.Add([ordered]@{
      gid = [string]$attachment.gid
      name = $originalName
      created_at = $attachment.created_at
      local_file = $localFile
    }) | Out-Null
  }
  return ,$records.ToArray()
}

function Get-AsanaTaskBundle {
  param(
    [Parameter(Mandatory = $true)]$Task,
    [Parameter(Mandatory = $true)][string]$AttachmentsDirectory
  )

  $stories = @()
  try {
    $stories = @(Get-AsanaItems -Path "tasks/$($Task.gid)/stories" `
      -Fields 'gid,created_at,created_by.gid,created_by.name,resource_subtype,text,html_text')
  } catch {
    Write-Warning "Could not export stories for task '$($Task.name)'; its task data will still be exported."
  }

  $subtasks = @()
  try {
    $children = Get-AsanaItems -Path "tasks/$($Task.gid)/subtasks" `
      -Fields 'gid,name,notes,html_notes,completed,completed_at,due_on,created_at,modified_at,created_by.gid,created_by.name,assignee.gid,assignee.name,parent.gid,memberships.project.gid,memberships.section.name,custom_fields.name,custom_fields.display_value'
    foreach ($child in $children) {
      $subtasks += ,(Get-AsanaTaskBundle -Task $child -AttachmentsDirectory $AttachmentsDirectory)
    }
  } catch {
    Write-Warning "Could not export subtasks for task '$($Task.name)'; its task data will still be exported."
  }

  return [ordered]@{
    task = $Task
    stories = $stories
    subtasks = $subtasks
    attachments = @(Get-AsanaAttachmentRecords -Task $Task -AttachmentsDirectory $AttachmentsDirectory)
  }
}

function Save-MonthJsonPart {
  param(
    [Parameter(Mandatory = $true)]$ProjectRecord,
    [Parameter(Mandatory = $true)][string]$MonthLabel,
    [Parameter(Mandatory = $true)][object[]]$TaskBundles,
    [Parameter(Mandatory = $true)][int]$PartNumber,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][int]$MaxJsonBytes
  )

  $document = [ordered]@{ project = $ProjectRecord }
  $document[$MonthLabel] = $TaskBundles
  $json = ConvertTo-Json -InputObject $document -Depth 100 -Compress
  if ([System.Text.Encoding]::UTF8.GetByteCount($json) -gt $MaxJsonBytes) {
    throw "Month '$MonthLabel' part $PartNumber exceeds the export size limit."
  }
  $fileName = if ($PartNumber -eq 1) { "$MonthLabel.json" } else { "$MonthLabel ($PartNumber).json" }
  $jsonPath = Join-Path $OutputRoot $fileName
  $temporaryJsonPath = "$jsonPath.tmp"
  Set-Content -LiteralPath $temporaryJsonPath -Value $json -Encoding UTF8
  Move-Item -LiteralPath $temporaryJsonPath -Destination $jsonPath -Force
  return $jsonPath
}

$secureToken = Read-Host 'Paste your Asana personal access token (input is hidden)' -AsSecureString
if ($secureToken.Length -lt 1) { throw 'An Asana personal access token is required.' }
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $script:AsanaToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}

$projectGid = (Read-Host 'Asana project GID').Trim()
if ($projectGid -notmatch '^\d+$') { throw 'The project GID must contain digits only.' }

try {
  $projectFields = 'gid,name,created_at,members.gid,members.name'
  $projectUri = "$script:AsanaApiRoot/projects/$projectGid`?opt_fields=$([uri]::EscapeDataString($projectFields))"
  $project = (Invoke-AsanaApi -Uri $projectUri).data
  if (-not $project.gid -or -not $project.name) { throw 'Asana did not return project ID and name.' }

  $runStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outputRoot = Join-Path (Split-Path -Parent $PSScriptRoot) ("asana-project-{0}-{1}" -f $projectGid, $runStamp)
  $attachmentsDirectory = Join-Path $outputRoot 'attachments'
  New-Item -ItemType Directory -Path $attachmentsDirectory -Force | Out-Null

  $members = @()
  foreach ($member in @($project.members)) {
    if ($member -and $member.gid -and $member.name) {
      $members += [ordered]@{ gid = [string]$member.gid; name = [string]$member.name }
    }
  }
  $projectRecord = [ordered]@{
    gid = [string]$project.gid
    name = [string]$project.name
    created_at = $project.created_at
    members = $members
  }

  $taskFields = 'gid,name,notes,html_notes,completed,completed_at,due_on,created_at,modified_at,created_by.gid,created_by.name,assignee.gid,assignee.name,parent.gid,memberships.project.gid,memberships.section.name,custom_fields.name,custom_fields.display_value'
  $allTasks = Get-AsanaItems -Path "projects/$projectGid/tasks" -Fields $taskFields
  $topLevelTasks = @($allTasks | Where-Object { -not $_.parent -or -not $_.parent.gid })
  $taskRecords = New-Object 'System.Collections.Generic.List[object]'
  foreach ($task in $topLevelTasks) {
    $taskDate = [DateTimeOffset]::MinValue
    $dateValue = $task.created_at
    if (-not $dateValue) { $dateValue = $task.modified_at }
    if ($dateValue) {
      try { $taskDate = [DateTimeOffset]::Parse([string]$dateValue, [Globalization.CultureInfo]::InvariantCulture) } catch {}
    }
    $monthLabel = if ($taskDate -eq [DateTimeOffset]::MinValue) { 'Unknown date' } else { $taskDate.ToString('MMM yy', [Globalization.CultureInfo]::InvariantCulture) }
    $monthSortKey = if ($taskDate -eq [DateTimeOffset]::MinValue) { '0000-00' } else { $taskDate.ToString('yyyy-MM', [Globalization.CultureInfo]::InvariantCulture) }
    $taskRecords.Add([pscustomobject]@{
      Task = $task
      TaskDate = $taskDate
      MonthLabel = $monthLabel
      MonthSortKey = $monthSortKey
    }) | Out-Null
  }
  $monthGroups = @($taskRecords | Group-Object -Property MonthSortKey | Sort-Object -Property Name -Descending)
  $maxJsonBytes = 10 * 1024 * 1024
  $oversizedTasks = New-Object 'System.Collections.Generic.List[string]'
  $failedTasks = New-Object 'System.Collections.Generic.List[string]'
  $writtenFiles = New-Object 'System.Collections.Generic.List[string]'
  $processedTasks = 0
  foreach ($monthGroup in $monthGroups) {
    $monthTasks = @($monthGroup.Group | Sort-Object -Property TaskDate -Descending)
    $monthLabel = [string]$monthTasks[0].MonthLabel
    $monthBaseDocument = [ordered]@{ project = $projectRecord }
    $monthBaseDocument[$monthLabel] = [object[]]@()
    $monthBaseBytes = [System.Text.Encoding]::UTF8.GetByteCount((ConvertTo-Json -InputObject $monthBaseDocument -Depth 100 -Compress))
    $monthBytes = $monthBaseBytes
    $monthPartNumber = 1
    $monthBundles = New-Object 'System.Collections.Generic.List[object]'

    foreach ($taskRecord in $monthTasks) {
      $processedTasks++
      $task = $taskRecord.Task
      Write-Progress -Activity 'Exporting Asana project' -Status "Reading task $processedTasks of $($topLevelTasks.Count): $($task.name) ($monthLabel)" -PercentComplete ([int]($processedTasks * 100 / [Math]::Max(1, $topLevelTasks.Count)))
      try {
        $bundle = Get-AsanaTaskBundle -Task $task -AttachmentsDirectory $attachmentsDirectory
        $bundleJson = ConvertTo-Json -InputObject $bundle -Depth 100 -Compress
        $bundleBytes = [System.Text.Encoding]::UTF8.GetByteCount($bundleJson)
        $separatorBytes = if ($monthBundles.Count) { 1 } else { 0 }

        if ($monthBytes + $separatorBytes + $bundleBytes -gt $maxJsonBytes -and $monthBundles.Count) {
          $savedPath = Save-MonthJsonPart -ProjectRecord $projectRecord -MonthLabel $monthLabel `
            -TaskBundles $monthBundles.ToArray() -PartNumber $monthPartNumber -OutputRoot $outputRoot -MaxJsonBytes $maxJsonBytes
          $writtenFiles.Add($savedPath) | Out-Null
          Write-Host "Saved $monthLabel task batch $monthPartNumber."
          $monthPartNumber++
          $monthBundles = New-Object 'System.Collections.Generic.List[object]'
          $monthBytes = $monthBaseBytes
          $separatorBytes = 0
        }

        if ($monthBytes + $separatorBytes + $bundleBytes -gt $maxJsonBytes) {
          $oversizedTasks.Add([string]$task.name) | Out-Null
          Write-Warning "Skipped '$($task.name)' ($monthLabel): its task data and activity exceed the 10 MB per-file target."
          continue
        }
        $monthBundles.Add($bundle) | Out-Null
        $monthBytes += $separatorBytes + $bundleBytes
      } catch {
        $failedTasks.Add([string]$task.name) | Out-Null
        Write-Warning "Failed to export task '$($task.name)' ($monthLabel); continuing. $($_.Exception.Message)"
      }
    }

    if ($monthBundles.Count) {
      $savedPath = Save-MonthJsonPart -ProjectRecord $projectRecord -MonthLabel $monthLabel `
        -TaskBundles $monthBundles.ToArray() -PartNumber $monthPartNumber -OutputRoot $outputRoot -MaxJsonBytes $maxJsonBytes
      $writtenFiles.Add($savedPath) | Out-Null
      Write-Host "Saved $monthLabel task batch $monthPartNumber -> $(Split-Path -Leaf $savedPath)"
    }
  }
  Write-Progress -Activity 'Exporting Asana project' -Completed
  if ($writtenFiles.Count -eq 0 -and $topLevelTasks.Count) {
    throw 'No task JSON files were created. Review the per-task warnings above; oversized tasks exceed the 10 MB per-file target.'
  }
  Write-Host "Exported '$($project.name)': $($writtenFiles.Count) month JSON file(s) saved from $($topLevelTasks.Count) top-level tasks."
  if ($oversizedTasks.Count) { Write-Warning "Oversized tasks skipped ($($oversizedTasks.Count)): $($oversizedTasks -join '; ')" }
  if ($failedTasks.Count) { Write-Warning "Tasks with export errors ($($failedTasks.Count)): $($failedTasks -join '; ')" }
  if ($writtenFiles.Count -gt 0) { Write-Host "Newest month JSON: $($writtenFiles[0])" }
  if ($writtenFiles.Count -gt 1) { Write-Host 'Each JSON has a month key containing that month’s task array. Select the export folder in TaskFlow to import months newest-to-oldest.' }
  Write-Host "Export folder: $outputRoot"
  Write-Host "Downloaded attachments: $attachmentsDirectory"
  Write-Host 'In TaskFlow, select the project export folder in Admin > Project data import / export.'
} finally {
  $script:AsanaToken = $null
  $secureToken.Dispose()
}