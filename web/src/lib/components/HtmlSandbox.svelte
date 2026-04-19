<script lang="ts">
  import { buildSrcdoc } from '../sandbox.js';

  interface Props {
    html: string;
    allowImages: boolean;
  }

  let { html, allowImages }: Props = $props();

  const srcdoc = $derived(buildSrcdoc(html, { allowRemoteImages: allowImages }));
</script>

<!--
  Sandbox notes:
  - sandbox="allow-popups" ONLY — no allow-scripts, no allow-same-origin.
  - srcdoc CSP is defense-in-depth against malformed sanitization upstream.
  - referrerpolicy=no-referrer prevents leaking the current URL to remote hosts.
-->
<iframe
  title="Email content"
  sandbox="allow-popups"
  referrerpolicy="no-referrer"
  loading="lazy"
  {srcdoc}
  class="h-[60vh] max-h-[640px] min-h-[240px] w-full rounded-md border border-slate-200 bg-white"
></iframe>
