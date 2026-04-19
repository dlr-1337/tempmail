<script lang="ts">
  import { X } from 'lucide-svelte';
  import { dismissToast, toast } from '../state.svelte.js';

  let autoDismiss: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const t = toast.current;
    if (!t) return;
    if (autoDismiss) clearTimeout(autoDismiss);
    autoDismiss = setTimeout(() => {
      dismissToast();
    }, 5000);
    return () => {
      if (autoDismiss) clearTimeout(autoDismiss);
    };
  });
</script>

{#if toast.current}
  {@const t = toast.current}
  <div
    role="status"
    aria-live="polite"
    class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 md:bottom-auto md:left-auto md:right-4 md:top-4 md:justify-end"
  >
    <div
      class="pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border px-4 py-3 shadow-lg"
      class:bg-white={t.type === 'info'}
      class:border-slate-200={t.type === 'info'}
      class:text-slate-900={t.type === 'info'}
      class:bg-amber-50={t.type === 'warning'}
      class:border-amber-200={t.type === 'warning'}
      class:text-amber-900={t.type === 'warning'}
      class:bg-rose-50={t.type === 'error'}
      class:border-rose-200={t.type === 'error'}
      class:text-rose-900={t.type === 'error'}
      class:bg-emerald-50={t.type === 'success'}
      class:border-emerald-200={t.type === 'success'}
      class:text-emerald-900={t.type === 'success'}
    >
      <p class="text-sm font-medium">{t.message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        class="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-current/70 hover:text-current"
        onclick={dismissToast}
      >
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  </div>
{/if}
