<script lang="ts">
  import { Inbox, Paperclip } from 'lucide-svelte';
  import { session } from '../state.svelte.js';
  import { formatRelative } from '../time.js';
  import type { MessageView } from '../types.js';

  interface Props {
    onSelect: (msg: MessageView) => void;
  }

  let { onSelect }: Props = $props();
</script>

{#if session.messages.length === 0}
  <div
    class="rounded-xl border border-dashed border-slate-300 bg-white/60 p-10 text-center"
  >
    <Inbox class="mx-auto mb-3 h-10 w-10 text-slate-400" aria-hidden="true" />
    <p class="text-lg font-semibold text-slate-800">Waiting for mail…</p>
    <p class="mt-1 text-sm text-slate-600">
      Send an email to the address above. It'll show up here as soon as it arrives.
    </p>
  </div>
{:else}
  <ul class="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
    {#each session.messages as msg (msg.id)}
      <li>
        <button
          type="button"
          onclick={() => onSelect(msg)}
          class="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus:bg-slate-50 md:px-5 md:py-4"
        >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p class="truncate text-sm font-semibold text-slate-900">{msg.from}</p>
              <span class="text-xs text-slate-500">{formatRelative(msg.receivedAt, session.now)}</span>
            </div>
            <p class="mt-0.5 truncate text-sm text-slate-700">
              {msg.subject || '(no subject)'}
            </p>
          </div>
          {#if msg.attachmentCount > 0}
            <span
              class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
              aria-label="{msg.attachmentCount} attachments"
            >
              <Paperclip class="h-3 w-3" aria-hidden="true" />
              {msg.attachmentCount}
            </span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}
