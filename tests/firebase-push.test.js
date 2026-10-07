'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { formatActivityNotification } = require('../lib/firebase-push');

test('task completion push identifies the actor and task', () => {
  assert.deepEqual(formatActivityNotification({
    action: 'Task completed',
    actor_name: 'Amit',
    task_title: 'SRS Router Buy'
  }), {
    title: 'Task completed',
    body: 'Amit completed "SRS Router Buy".'
  });
});

test('task comment push identifies the actor and task', () => {
  assert.deepEqual(formatActivityNotification({
    action: 'Task comment added',
    actor_name: 'Amit',
    task_title: 'SRS Router Buy'
  }), {
    title: 'New task comment',
    body: 'Amit commented on "SRS Router Buy".'
  });
});

test('task due-date push identifies the actor, task, and date change', () => {
  assert.deepEqual(formatActivityNotification({
    action: 'Task due date changed',
    actor_name: 'Amit',
    task_title: 'SRS Router Buy',
    details: '2026-10-06 -> 2026-10-10'
  }), {
    title: 'Task due date changed',
    body: 'Amit changed the due date for "SRS Router Buy": 2026-10-06 -> 2026-10-10.'
  });
});

test('expense approval push identifies the approver, claimant, and expense', () => {
  assert.deepEqual(formatActivityNotification({
    action: 'Reimbursement approved (level 1)',
    actor_name: 'Amit',
    subject_name: 'Siddhesh',
    details: 'INR 1099.00 - Travel'
  }), {
    title: 'Expense approved (level 1)',
    body: "Amit approved Siddhesh's expense: INR 1099.00 - Travel."
  });
});