export type InboxProcessingResult<Result> =
  | { readonly processed: true; readonly result: Result }
  | { readonly processed: false };
