// Mirror of Phase 5 API types. Do not import from ../../../src — cross-boundary.

export interface InboxMintResponse {
  id: string;
  address: string;
  createdAt: string; // ISO
  expiresAt: string; // ISO
}

export interface InboxMetadata {
  id: string;
  address: string;
  createdAt: string;
  expiresAt: string;
  messageCount: number;
}

export interface AttachmentMetadata {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/** Message-list view (no bodies — saves bandwidth). */
export interface MessageView {
  id: string;
  from: string;
  subject: string;
  receivedAt: string; // ISO
  hasTextBody: boolean;
  hasHtmlBody: boolean;
  attachmentCount: number;
}

/** Full-message view including bodies + attachment metadata. */
export interface FullMessageView extends MessageView {
  textBody: string | null;
  htmlBody: string | null; // server-sanitized by Phase 4
  attachments: AttachmentMetadata[];
}

/** Phase 5 error envelope. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'invalid_request'
  | 'server_error';
