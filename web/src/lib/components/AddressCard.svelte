<script lang="ts">
  import { Plus } from 'lucide-svelte';
  import { mintNewInbox, session } from '../state.svelte.js';
  import Countdown from './Countdown.svelte';
  import CopyButton from './CopyButton.svelte';

  async function handleNewInbox(): Promise<void> {
    await mintNewInbox();
  }
</script>

<section
  class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6"
  aria-label="Your temporary email address"
>
  <div class="flex flex-col gap-4">
    <p class="text-xs font-medium uppercase tracking-wider text-slate-500">
      Your address
    </p>
    <div class="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
      <p
        class="flex-1 break-all font-mono text-xl font-semibold text-slate-900 md:text-2xl"
        data-testid="inbox-address"
      >
        {#if session.inbox}
          {session.inbox.address}
        {:else if session.loading}
          <span class="text-slate-400">Preparing inbox…</span>
        {:else}
          <span class="text-slate-400">—</span>
        {/if}
      </p>
      {#if session.inbox}
        <CopyButton text={session.inbox.address} label="Copy" />
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <Countdown
        expiresAt={session.inbox?.expiresAt ?? null}
        now={session.now}
      />
      <button
        type="button"
        onclick={handleNewInbox}
        disabled={session.loading}
        class="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm transition-colors hover:bg-slate-50 active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Plus class="h-4 w-4" aria-hidden="true" />
        New inbox
      </button>
    </div>
  </div>
</section>
