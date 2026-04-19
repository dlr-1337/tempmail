<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowLeft, ImageIcon, ShieldCheck } from 'lucide-svelte';
  import { session } from '../state.svelte.js';
  import { formatRelative } from '../time.js';
  import type { FullMessageView } from '../types.js';
  import AttachmentList from './AttachmentList.svelte';
  import HtmlSandbox from './HtmlSandbox.svelte';

  interface Props {
    message: FullMessageView;
    onClose: () => void;
  }

  let { message, onClose }: Props = $props();

  type Tab = 'text' | 'html' | 'attachments';

  function defaultTabFor(msg: FullMessageView): Tab {
    if (msg.hasTextBody) return 'text';
    if (msg.hasHtmlBody) return 'html';
    return 'attachments';
  }

  let currentTab = $state<Tab>('text');
  let allowImages = $state(false);
  let seenId = $state<string | null>(null);

  // Reset per-message image permission + tab whenever the message id changes.
  $effect(() => {
    if (message.id !== seenId) {
      seenId = message.id;
      allowImages = false;
      currentTab = defaultTabFor(message);
    }
  });

  function handleKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') onClose();
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

<div
  class="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 md:items-center md:p-4"
  role="dialog"
  aria-modal="true"
  aria-label="Message detail"
>
  <div
    class="relative flex h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-xl bg-white shadow-2xl md:h-[85vh] md:rounded-xl"
  >
    <header class="flex items-start gap-3 border-b border-slate-200 px-4 py-4 md:px-6">
      <button
        type="button"
        onclick={onClose}
        aria-label="Back to inbox"
        class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
      >
        <ArrowLeft class="h-5 w-5" aria-hidden="true" />
      </button>
      <div class="min-w-0 flex-1">
        <p class="truncate text-xs text-slate-500">From</p>
        <p class="truncate text-sm font-semibold text-slate-900">{message.from}</p>
        <p class="mt-1 truncate text-base font-bold text-slate-900">
          {message.subject || '(no subject)'}
        </p>
        <p class="text-xs text-slate-500">{formatRelative(message.receivedAt, session.now)}</p>
      </div>
    </header>

    <nav class="flex items-center gap-2 border-b border-slate-200 px-4 pb-1 md:px-6" aria-label="Message views">
      {#if message.hasTextBody}
        <button
          type="button"
          onclick={() => { currentTab = 'text'; }}
          class="min-h-11 border-b-2 px-3 py-2 text-sm font-medium"
          class:border-blue-600={currentTab === 'text'}
          class:text-blue-700={currentTab === 'text'}
          class:border-transparent={currentTab !== 'text'}
          class:text-slate-600={currentTab !== 'text'}
        >
          Text
        </button>
      {/if}
      {#if message.hasHtmlBody}
        <button
          type="button"
          onclick={() => { currentTab = 'html'; }}
          class="min-h-11 border-b-2 px-3 py-2 text-sm font-medium"
          class:border-blue-600={currentTab === 'html'}
          class:text-blue-700={currentTab === 'html'}
          class:border-transparent={currentTab !== 'html'}
          class:text-slate-600={currentTab !== 'html'}
        >
          HTML
        </button>
      {/if}
      <button
        type="button"
        onclick={() => { currentTab = 'attachments'; }}
        class="min-h-11 border-b-2 px-3 py-2 text-sm font-medium"
        class:border-blue-600={currentTab === 'attachments'}
        class:text-blue-700={currentTab === 'attachments'}
        class:border-transparent={currentTab !== 'attachments'}
        class:text-slate-600={currentTab !== 'attachments'}
      >
        Attachments ({message.attachments.length})
      </button>
    </nav>

    <div class="flex-1 overflow-auto px-4 py-4 md:px-6">
      {#if currentTab === 'text'}
        {#if message.textBody}
          <pre class="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-slate-800">{message.textBody}</pre>
        {:else}
          <p class="text-sm text-slate-500">No plain-text body.</p>
        {/if}
      {:else if currentTab === 'html' && message.htmlBody}
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <ShieldCheck class="h-4 w-4 text-emerald-600" aria-hidden="true" />
            <span>Rendered in a sandbox. Remote images are blocked by default.</span>
            {#if !allowImages}
              <button
                type="button"
                onclick={() => { allowImages = true; }}
                class="ml-auto inline-flex min-h-9 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100"
              >
                <ImageIcon class="h-3.5 w-3.5" aria-hidden="true" />
                Load images
              </button>
            {:else}
              <span class="ml-auto text-xs text-slate-500">Images loaded for this message.</span>
            {/if}
          </div>
          <HtmlSandbox html={message.htmlBody} {allowImages} />
        </div>
      {:else if currentTab === 'html'}
        <p class="text-sm text-slate-500">No HTML body.</p>
      {:else if currentTab === 'attachments'}
        {#if session.inbox}
          <AttachmentList inboxId={session.inbox.id} attachments={message.attachments} />
        {/if}
      {/if}
    </div>
  </div>
</div>
