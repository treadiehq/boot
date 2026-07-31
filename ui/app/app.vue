<script setup lang="ts">
import type {
  ConsoleLine,
  UpStreamLine,
  WorkspaceDiagnostics,
  WorkspaceSummary,
} from "~/types";

/* ------------------------------ state ------------------------------ */

const workspaces = ref<WorkspaceSummary[]>([]);
const loaded = ref(false);
const selectedRoot = ref<string | null>(null);
const profile = ref<string | null>(null);
const diagnostics = ref<WorkspaceDiagnostics | null>(null);
const inspecting = ref(false);
const inspectError = ref<string | null>(null);

const runSetup = ref(true);
const startServices = ref(true);
const launching = ref(false);
const consoleLines = ref<ConsoleLine[]>([]);
const elapsedSeconds = ref<number | null>(null);
const ideMessage = ref<string | null>(null);
const copied = ref(false);

let timer: ReturnType<typeof setInterval> | null = null;
let inspectToken = 0;

const selected = computed(
  () => workspaces.value.find((workspace) => workspace.root === selectedRoot.value) ?? null,
);

const launchCommand = computed(() => {
  if (!selected.value) return "";
  const parts = ["boot up", shortPath(selected.value.root)];
  if (profile.value) parts.push(`--profile ${profile.value}`);
  if (runSetup.value) parts.push("--run-setup");
  if (startServices.value) parts.push("--start");
  return parts.join(" ");
});

const repoStats = computed(() => {
  const repos = diagnostics.value?.repositories ?? [];
  return {
    total: repos.length,
    ready: repos.filter((repo) => repo.state === "hydrated" && repo.action === "none").length,
  };
});

const requirementStats = computed(() => {
  const d = diagnostics.value;
  if (!d) return { total: 0, met: 0 };
  const requirements = [...d.tools, ...d.services];
  const met =
    requirements.filter((requirement) => requirement.state === "available").length +
    d.environment.filter((env) => env.available).length;
  return { total: requirements.length + d.environment.length, met };
});

/* ------------------------------ loading ---------------------------- */

onMounted(async () => {
  try {
    const response = await fetch("/api/workspaces");
    const body = (await response.json()) as { workspaces: WorkspaceSummary[] };
    workspaces.value = body.workspaces;
    const first = body.workspaces.find((workspace) => workspace.exists && !workspace.error);
    if (first) selectWorkspace(first.root);
  } finally {
    loaded.value = true;
  }
});

function selectWorkspace(root: string): void {
  if (selectedRoot.value === root) return;
  selectedRoot.value = root;
  const workspace = workspaces.value.find((candidate) => candidate.root === root);
  profile.value = workspace?.defaultProfile ?? workspace?.profiles[0] ?? null;
  diagnostics.value = null;
  resetLaunch();
  void refreshDiagnostics();
}

function selectProfile(name: string): void {
  if (profile.value === name) return;
  profile.value = name;
  diagnostics.value = null;
  resetLaunch();
  void refreshDiagnostics();
}

async function refreshDiagnostics(): Promise<void> {
  const root = selectedRoot.value;
  if (!root) return;
  const token = ++inspectToken;
  inspecting.value = true;
  inspectError.value = null;
  try {
    const params = new URLSearchParams({ root });
    if (profile.value) params.set("profile", profile.value);
    const response = await fetch(`/api/inspect?${params}`);
    const body = await response.json();
    if (token !== inspectToken) return;
    if (!response.ok) {
      diagnostics.value = null;
      inspectError.value = (body as { error?: string }).error ?? "Inspection failed.";
      return;
    }
    diagnostics.value = body as WorkspaceDiagnostics;
  } catch {
    if (token === inspectToken) inspectError.value = "Could not reach the boot ui server.";
  } finally {
    if (token === inspectToken) inspecting.value = false;
  }
}

/* ------------------------------ launch ----------------------------- */

function resetLaunch(): void {
  consoleLines.value = [];
  launching.value = false;
  elapsedSeconds.value = null;
  ideMessage.value = null;
  if (timer) clearInterval(timer);
  timer = null;
}

function pushLine(glyph: string, text: string, tone: ConsoleLine["tone"]): void {
  consoleLines.value.push({ glyph, text, tone });
}

function handleStreamLine(line: UpStreamLine): void {
  if (line.type === "plan") {
    pushLine("▸", line.ready ? "plan resolved — workspace already satisfies boot.yaml" : `plan resolved — ${line.blockers.length} item${line.blockers.length === 1 ? "" : "s"} to fix`, "dim");
  } else if (line.type === "service") {
    if (line.phase === "starting") pushLine("•", `starting service ${line.service} — ${line.detail ?? ""}`, "info");
    else if (line.phase === "waiting") pushLine(" ", `waiting for ${line.service} to report healthy…`, "dim");
    else if (line.phase === "ready") pushLine("✓", `service ${line.service} is healthy${line.detail ? ` (${line.detail})` : ""}`, "ok");
    else if (line.phase === "skipped") pushLine("–", `skipped ${line.service}: ${line.detail ?? ""}`, "dim");
    else if (line.phase === "failed") pushLine("✗", `${line.service}: ${line.detail ?? "failed"}`, "error");
  } else if (line.type === "result") {
    for (const failure of line.failures) {
      pushLine("✗", `${failure.kind} ${failure.name}: ${failure.message}`, "error");
    }
    const commands = line.applied.filter((item) => item.kind === "command");
    for (const command of commands) pushLine("✓", `command ${command.name}`, "ok");
    pushLine(
      line.ready ? "✓" : "✗",
      line.ready
        ? `workspace ready in ${elapsedSeconds.value?.toFixed(1) ?? "?"}s`
        : "workspace is not ready — fix the reported problems and relaunch",
      line.ready ? "ok" : "error",
    );
    diagnostics.value = line.diagnostics;
  } else if (line.type === "error") {
    pushLine("✗", line.message, "error");
  }
}

async function launch(): Promise<void> {
  if (!selectedRoot.value || launching.value) return;
  resetLaunch();
  launching.value = true;
  const startedAt = Date.now();
  elapsedSeconds.value = 0;
  timer = setInterval(() => {
    elapsedSeconds.value = (Date.now() - startedAt) / 1000;
  }, 100);

  try {
    const response = await fetch("/api/up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: selectedRoot.value,
        profile: profile.value ?? undefined,
        runSetup: runSetup.value,
        start: startServices.value,
      }),
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      pushLine("✗", (body as { error?: string }).error ?? "Launch failed.", "error");
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (raw) handleStreamLine(JSON.parse(raw) as UpStreamLine);
        newline = buffer.indexOf("\n");
      }
    }
  } catch {
    pushLine("✗", "Lost connection to the boot ui server.", "error");
  } finally {
    launching.value = false;
    if (timer) clearInterval(timer);
    timer = null;
  }
}

async function openIde(): Promise<void> {
  if (!selectedRoot.value) return;
  ideMessage.value = null;
  const response = await fetch("/api/open-ide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: selectedRoot.value }),
  });
  const body = (await response.json()) as { opened?: string; error?: string };
  ideMessage.value = response.ok ? `opened in ${body.opened}` : (body.error ?? "could not open");
  setTimeout(() => (ideMessage.value = null), 4000);
}

async function copyCommand(): Promise<void> {
  await navigator.clipboard.writeText(launchCommand.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

function shortPath(root: string): string {
  return root.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

const repoStateLabel: Record<string, { text: string; cls: string }> = {
  hydrated: { text: "cloned", cls: "text-emerald-400" },
  placeholder: { text: "placeholder", cls: "text-zinc-500" },
  missing: { text: "missing", cls: "text-amber-300" },
  conflict: { text: "conflict", cls: "text-red-400" },
};
</script>

<template>
  <div class="flex h-full font-sans">
    <WorkspaceRail
      :workspaces="workspaces"
      :selected-root="selectedRoot"
      @select="selectWorkspace"
    />

    <main class="min-w-0 flex-1 overflow-y-auto">
      <!-- Empty state -->
      <div
        v-if="loaded && workspaces.length === 0"
        class="flex h-full flex-col items-center justify-center px-8"
      >
        <div class="font-mono text-lg text-zinc-100 flex items-center gap-1.5">
          <img src="/logo.png" alt="boot" class="h-6 w-6" />
          boot
        </div>
        <p class="mt-3 max-w-sm text-center text-[13px] leading-relaxed text-zinc-500">
          No workspaces registered yet. Prepare one from your terminal and it will appear here:
        </p>
        <div class="mt-5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 font-mono text-[12.5px] text-zinc-300">
          <div><span class="text-zinc-600">$</span> boot init ~/code</div>
          <div class="mt-1"><span class="text-zinc-600">$</span> boot up ~/code</div>
        </div>
      </div>

      <!-- Workspace detail -->
      <div v-else-if="selected" class="mx-auto max-w-3xl px-8 py-10">
        <!-- Header -->
        <header class="flex items-start justify-between gap-6">
          <div class="min-w-0">
            <h1 class="truncate text-[22px] font-semibold tracking-tight text-zinc-100">
              {{ selected.name ?? shortPath(selected.root) }}
            </h1>
            <p class="mt-1 truncate font-mono text-[12px] text-zinc-600">
              {{ shortPath(selected.root) }}
            </p>
            <p v-if="selected.description" class="mt-2 text-[13px] text-zinc-500">
              {{ selected.description }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2 pt-1">
            <span v-if="ideMessage" class="text-[12px] text-zinc-500">{{ ideMessage }}</span>
            <button
              class="h-8 rounded-lg flex items-center gap-1.5 border border-zinc-800 px-3 text-[12.5px] font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
              @click="openIde"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="size-4 text-zinc-500 hover:text-zinc-100">
                <path fill-rule="evenodd" d="M4.25 2A2.25 2.25 0 0 0 2 4.25v11.5A2.25 2.25 0 0 0 4.25 18h11.5A2.25 2.25 0 0 0 18 15.75V4.25A2.25 2.25 0 0 0 15.75 2H4.25Zm4.03 6.28a.75.75 0 0 0-1.06-1.06L4.97 9.47a.75.75 0 0 0 0 1.06l2.25 2.25a.75.75 0 0 0 1.06-1.06L6.56 10l1.72-1.72Zm4.5-1.06a.75.75 0 1 0-1.06 1.06L13.44 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06l2.25-2.25a.75.75 0 0 0 0-1.06l-2.25-2.25Z" clip-rule="evenodd" />
              </svg>
              <span class="text-[12px] text-zinc-500 hover:text-zinc-100">Open in IDE</span>
            </button>
          </div>
        </header>

        <!-- Profile switcher -->
        <div v-if="selected.profiles.length > 0" class="mt-6 inline-flex rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          <button
            v-for="name in selected.profiles"
            :key="name"
            class="rounded-md px-3 py-1 font-mono text-[12px] transition-colors"
            :class="
              name === profile
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            "
            @click="selectProfile(name)"
          >
            {{ name }}
          </button>
        </div>

        <!-- Inspect error -->
        <div
          v-if="inspectError"
          class="mt-6 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-[13px] text-red-300"
        >
          {{ inspectError }}
        </div>

        <template v-else-if="diagnostics">
          <!-- Stats -->
          <div class="mt-6 grid grid-cols-3 gap-3">
            <div class="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-3.5">
              <div class="text-[20px] font-semibold tabular-nums tracking-tight text-zinc-100">
                {{ repoStats.ready }}<span class="text-zinc-600">/{{ repoStats.total }}</span>
              </div>
              <div class="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-zinc-600">
                Repositories ready
              </div>
            </div>
            <div class="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-3.5">
              <div class="text-[20px] font-semibold tabular-nums tracking-tight text-zinc-100">
                {{ requirementStats.met }}<span class="text-zinc-600">/{{ requirementStats.total }}</span>
              </div>
              <div class="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-zinc-600">
                Requirements met
              </div>
            </div>
            <div class="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-3.5">
              <div
                class="text-[20px] font-semibold tracking-tight"
                :class="diagnostics.workspace.ready ? 'text-emerald-400' : 'text-amber-300'"
              >
                {{ diagnostics.workspace.ready ? "ready" : "attention" }}
              </div>
              <div class="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-zinc-600">
                {{ profile ?? "default" }} profile
              </div>
            </div>
          </div>

          <!-- Launch -->
          <section class="mt-8">
            <div class="flex items-center justify-between">
              <h2 class="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                Launch
              </h2>
              <div class="flex items-center gap-4">
                <ToggleSwitch v-model="runSetup" label="run setup" />
                <ToggleSwitch v-model="startServices" label="start services" />
              </div>
            </div>

            <div class="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4">
              <div class="flex items-center gap-3">
                <button
                  class="h-9 shrink-0 rounded-lg bg-zinc-100 px-4 text-[13px] font-semibold text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                  :disabled="launching || !selected.exists"
                  @click="launch"
                >
                  {{ launching ? "Preparing…" : "Prepare & launch" }}
                </button>
                <button
                  class="group flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 font-mono text-[12px] text-zinc-500 transition-colors hover:border-zinc-800 hover:text-zinc-400"
                  :title="copied ? 'Copied' : 'Copy command'"
                  @click="copyCommand"
                >
                  <span class="truncate">{{ launchCommand }}</span>
                  <span class="shrink-0 text-[10px] uppercase tracking-wider" :class="copied ? 'text-emerald-400' : 'text-zinc-700 group-hover:text-zinc-500'">
                    {{ copied ? "copied" : "copy" }}
                  </span>
                </button>
              </div>

              <LaunchConsole
                v-if="consoleLines.length > 0 || launching"
                class="mt-4"
                :lines="consoleLines"
                :running="launching"
                :elapsed-seconds="elapsedSeconds"
              />
            </div>
          </section>

          <!-- Blockers -->
          <div
            v-if="diagnostics.blockers.length > 0"
            class="mt-6 rounded-xl border border-amber-300/15 bg-amber-300/4 px-4 py-3.5"
          >
            <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300/80">
              Needs attention
            </div>
            <ul class="mt-2 space-y-1.5">
              <li
                v-for="blocker in diagnostics.blockers"
                :key="blocker"
                class="font-mono text-[12px] leading-relaxed text-amber-200/80"
              >
                {{ blocker }}
              </li>
            </ul>
          </div>

          <!-- Requirements -->
          <section
            v-if="diagnostics.tools.length + diagnostics.services.length + diagnostics.environment.length > 0"
            class="mt-8"
          >
            <h2 class="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
              Requirements
            </h2>
            <RequirementList
              class="mt-3"
              :tools="diagnostics.tools"
              :services="diagnostics.services"
              :environment="diagnostics.environment"
            />
          </section>

          <!-- Repositories -->
          <section v-if="diagnostics.repositories.length > 0" class="mt-8">
            <h2 class="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
              Repositories
            </h2>
            <div class="mt-3 divide-y divide-zinc-800/50 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/30">
              <div
                v-for="repo in diagnostics.repositories"
                :key="repo.id"
                class="flex items-center gap-3 px-4 py-2.5"
              >
                <span class="font-mono text-[13px] text-zinc-200">{{ repo.relativePath }}</span>
                <span v-if="repo.role" class="truncate text-[12px] text-zinc-600">{{ repo.role }}</span>
                <span class="ml-auto flex shrink-0 items-center gap-3">
                  <span v-if="repo.dirty" class="text-[11px] text-amber-300/80">dirty</span>
                  <span v-if="repo.currentRef" class="font-mono text-[11px] text-zinc-600">
                    {{ repo.currentRef }}
                  </span>
                  <span
                    class="font-mono text-[11px]"
                    :class="repoStateLabel[repo.state]?.cls ?? 'text-zinc-500'"
                  >
                    {{ repoStateLabel[repo.state]?.text ?? repo.state }}
                  </span>
                </span>
              </div>
            </div>
          </section>

          <!-- Constraints -->
          <section v-if="diagnostics.constraints.length > 0" class="mt-8 pb-10">
            <h2 class="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
              Constraints
            </h2>
            <ul class="mt-3 space-y-1.5">
              <li
                v-for="constraint in diagnostics.constraints"
                :key="constraint"
                class="text-[13px] leading-relaxed text-zinc-500"
              >
                {{ constraint }}
              </li>
            </ul>
          </section>
        </template>

        <!-- Inspecting skeleton -->
        <div v-else-if="inspecting" class="mt-6 space-y-3">
          <div class="boot-pulse h-16 rounded-xl border border-zinc-800/60 bg-zinc-900/30" />
          <div class="boot-pulse h-28 rounded-xl border border-zinc-800/60 bg-zinc-900/30" />
        </div>
      </div>
    </main>
  </div>
</template>
