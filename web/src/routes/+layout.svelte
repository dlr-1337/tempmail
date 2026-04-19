<script lang="ts">
  import { onMount } from 'svelte';
  import '../app.css';
  import Footer from '$lib/components/Footer.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import { initSession, stopClock, stopStream } from '$lib/state.svelte.js';

  let { children } = $props();

  onMount(() => {
    void initSession();
    return () => {
      stopStream();
      stopClock();
    };
  });
</script>

<div class="flex min-h-full flex-col">
  <header class="border-b border-slate-200 bg-white/70 backdrop-blur">
    <div class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 md:px-6">
      <a href="/" class="text-lg font-semibold tracking-tight text-slate-900">
        tempmail
      </a>
      <p class="text-xs text-slate-500">disposable • no signup</p>
    </div>
  </header>

  <main class="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-6 md:py-10">
    {@render children()}
  </main>

  <Footer />
</div>

<Toast />
