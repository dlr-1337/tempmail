<script lang="ts">
  import { Check, Copy } from 'lucide-svelte';

  interface Props {
    text: string;
    label?: string;
  }

  let { text, label = 'Copy' }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function handleCopy(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      copied = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        copied = false;
      }, 1500);
    } catch {
      // Silent — user-driven action with no data loss
    }
  }

  function fallbackCopy(value: string): void {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
  }
</script>

<button
  type="button"
  onclick={handleCopy}
  aria-label={label}
  class="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm transition-colors hover:bg-slate-50 active:bg-slate-100"
>
  {#if copied}
    <Check class="h-4 w-4 text-emerald-600" aria-hidden="true" />
    <span class="sr-only">Copied</span>
    <span>Copied</span>
  {:else}
    <Copy class="h-4 w-4" aria-hidden="true" />
    <span>{label}</span>
  {/if}
</button>
