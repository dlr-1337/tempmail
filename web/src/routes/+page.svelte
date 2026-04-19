<script lang="ts">
  import AddressCard from '$lib/components/AddressCard.svelte';
  import MessageList from '$lib/components/MessageList.svelte';
  import MessageDetail from '$lib/components/MessageDetail.svelte';
  import * as api from '$lib/api.js';
  import { pushToast, session } from '$lib/state.svelte.js';
  import type { FullMessageView, MessageView } from '$lib/types.js';

  let selected = $state<FullMessageView | null>(null);
  let loadingMessage = $state(false);

  async function handleSelect(msg: MessageView): Promise<void> {
    if (!session.inbox) return;
    loadingMessage = true;
    try {
      selected = await api.getMessage(session.inbox.id, msg.id);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Failed to load message');
    } finally {
      loadingMessage = false;
    }
  }

  function handleClose(): void {
    selected = null;
  }
</script>

<div class="flex flex-col gap-6">
  <AddressCard />

  <section aria-label="Messages">
    <div class="mb-3 flex items-baseline justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-600">
        Inbox ({session.messages.length})
      </h2>
      {#if loadingMessage}
        <span class="text-xs text-slate-500">Loading…</span>
      {/if}
    </div>
    <MessageList onSelect={handleSelect} />
  </section>
</div>

{#if selected}
  <MessageDetail message={selected} onClose={handleClose} />
{/if}
