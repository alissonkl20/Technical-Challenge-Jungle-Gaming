import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  type AwsConnectionSettings,
  awsConnectionSettings,
  type ConfigReader,
} from "../../config/settings.js";

export function createSqsClient(configuration: ConfigReader): SQSClient {
  const settings: AwsConnectionSettings = awsConnectionSettings(configuration);
  return new SQSClient({
    region: settings.region,
    endpoint: settings.endpoint,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  });
}

/**
 * Resolves queue URLs once per name. A failed lookup is evicted, so the next
 * call retries it instead of caching the failure.
 */
export class SqsQueueUrls {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly client: SQSClient) {}

  resolve(queueName: string): Promise<string> {
    let url = this.urls.get(queueName);
    if (url === undefined) {
      url = this.client
        .send(new GetQueueUrlCommand({ QueueName: queueName }))
        .then((response) => {
          if (response.QueueUrl === undefined) {
            throw new Error(`SQS queue "${queueName}" has no URL`);
          }
          return response.QueueUrl;
        })
        .catch((error: unknown) => {
          this.urls.delete(queueName);
          throw error;
        });
      this.urls.set(queueName, url);
    }
    return url;
  }
}
