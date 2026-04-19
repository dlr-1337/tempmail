<script lang="ts">
  import { formatMmSs } from '../time.js';

  interface Props {
    expiresAt: string | null;
    now: number;
  }

  let { expiresAt, now }: Props = $props();

  const remainingMs = $derived(
    expiresAt ? Math.max(0, Date.parse(expiresAt) - now) : 0
  );
  const display = $derived(formatMmSs(remainingMs));
  const warning = $derived(remainingMs > 0 && remainingMs < 60_000);
  const expired = $derived(expiresAt !== null && remainingMs <= 0);
</script>

<div
  class="inline-flex min-h-11 items-center gap-2 rounded-md px-3 py-2 font-mono text-sm tabular-nums"
  class:text-slate-700={!warning && !expired}
  class:bg-slate-100={!warning && !expired}
  class:text-amber-800={warning}
  class:bg-amber-100={warning}
  class:text-rose-700={expired}
  class:bg-rose-100={expired}
  aria-live="polite"
  aria-label="Inbox expires in {display}"
>
  <span class="h-2 w-2 rounded-full bg-current opacity-60" aria-hidden="true"></span>
  <span>{display}</span>
</div>
