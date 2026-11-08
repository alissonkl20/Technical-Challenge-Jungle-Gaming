#!/bin/bash
set -euo pipefail

awslocal sqs create-queue --queue-name "${SQS_OUTBOX_QUEUE_NAME:-test-queue}"
awslocal sqs create-queue --queue-name "${SQS_EVENT_DLQ_NAME:-financial-events-dlq}"
awslocal sqs create-queue --queue-name "${SQS_EVENT_QUEUE_NAME:-financial-events}"
awslocal sqs create-queue \
  --queue-name "${SQS_WAGER_COMMAND_QUEUE_NAME:-wager-transactions.fifo}" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
awslocal sqs create-queue \
  --queue-name "${SQS_WAGER_COMMAND_DLQ_NAME:-wager-transactions-dlq.fifo}" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
