<script setup lang="ts">
import type { WorkspaceSummary } from "~/types";

defineProps<{
  workspaces: WorkspaceSummary[];
  selectedRoot: string | null;
}>();

defineEmits<{ select: [root: string] }>();

function shortPath(root: string): string {
  return root.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
</script>

<template>
  <aside class="flex h-full w-64 shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-950">
    <!-- Wordmark -->
    <div class="px-5 pb-5 pt-6">
      <div class="font-mono text-[15px] font-semibold tracking-tight text-zinc-100 flex items-center gap-1.5">
        <img src="/logo.png" alt="boot" class="h-6 w-6" />
        Boot
      </div>
      <!-- <div class="mt-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-600">
        Launchpad
      </div> -->
    </div>

    <!-- Workspaces -->
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
      <div class="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
        Workspaces
      </div>
      <button
        v-for="workspace in workspaces"
        :key="workspace.root"
        class="group mb-1 block w-full rounded-lg border px-3 py-2.5 text-left transition-colors"
        :class="
          workspace.root === selectedRoot
            ? 'border-zinc-800 bg-zinc-900'
            : 'border-transparent hover:border-zinc-800/60 hover:bg-zinc-900/50'
        "
        @click="$emit('select', workspace.root)"
      >
        <div class="flex items-center gap-2">
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full"
            :class="workspace.exists && !workspace.error ? 'bg-emerald-400' : 'bg-red-400'"
          />
          <span
            class="truncate text-[13px] font-medium"
            :class="workspace.root === selectedRoot ? 'text-zinc-100' : 'text-zinc-300'"
          >
            {{ workspace.name ?? shortPath(workspace.root) }}
          </span>
        </div>
        <div class="mt-1 truncate pl-3.5 font-mono text-[11px] text-zinc-600">
          {{ shortPath(workspace.root) }}
        </div>
      </button>
    </div>

    <!-- Footer -->
    <!-- <div class="border-t border-zinc-800/70 px-5 py-4">
      <p class="text-[11px] leading-relaxed text-zinc-600">
        Served locally by
        <span class="font-mono text-zinc-500">boot ui</span> · nothing leaves this machine.
      </p>
    </div> -->
  </aside>
</template>
