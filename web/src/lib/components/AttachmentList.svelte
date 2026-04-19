<script lang="ts">
  import { Download, Paperclip } from 'lucide-svelte';
  import { attachmentUrl } from '../api.js';
  import { formatBytes } from '../time.js';
  import type { AttachmentMetadata } from '../types.js';

  interface Props {
    inboxId: string;
    attachments: AttachmentMetadata[];
  }

  let { inboxId, attachments }: Props = $props();
</script>

{#if attachments.length === 0}
  <p class="text-sm text-slate-500">No attachments.</p>
{:else}
  <ul class="divide-y divide-slate-200 overflow-hidden rounded-md border border-slate-200">
    {#each attachments as att (att.id)}
      <li class="flex items-center gap-3 px-4 py-3">
        <Paperclip class="h-4 w-4 text-slate-500" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-slate-800">{att.filename}</p>
          <p class="truncate text-xs text-slate-500">
            {att.contentType} • {formatBytes(att.size)}
          </p>
        </div>
        <a
          href={attachmentUrl(inboxId, att.id)}
          download={att.filename}
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
        >
          <Download class="h-4 w-4" aria-hidden="true" />
          Download
        </a>
      </li>
    {/each}
  </ul>
{/if}
