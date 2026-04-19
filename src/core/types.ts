/**
 * Type-only barrel for external callers that need Core shapes without
 * importing the factory (e.g. interface-only consumers, mock helpers).
 * The runtime exports live in './index.js'.
 */

export type { AbuseApi, RecordAbuseInput } from './abuse.js';
export type { Bus, BusEvents, MessageEvent } from './bus.js';
export type { CoreApi, CoreConfig, CoreDeps } from './index.js';
export type {
  CreateInboxResult,
  ExpireInboxResult,
  GetInboxResult,
  InboxAddressView,
  InboxView,
  InboxesApi,
  VerifyInboxAccessResult,
} from './inboxes.js';
export type {
  AttachmentDescriptor,
  AttachmentView,
  FullMessageView,
  GetAttachmentForInboxInput,
  GetAttachmentResult,
  GetMessageInput,
  GetMessageResult,
  IngestAttachmentInput,
  IngestInput,
  IngestResult,
  ListMessagesInput,
  ListMessagesResult,
  MessageView,
  MessagesApi,
} from './messages.js';
