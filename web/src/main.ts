import JSZip from "jszip";
import { assignIds, toCsv } from "./key";
import { detectPatients, classify } from "./scan";
import { runAll, type PatientReport, type RunPatient } from "./run";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type DirPicker = (o?: { mode?: "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
const pickDir = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
// Chrome/Edge write straight into a folder; other browsers get one ZIP (held in memory: fine for a few patients)
const zipMode = !pickDir || new URLSearchParams(location.search).get("zip") === "1";

let patients: RunPatient[] = [];
let lastZip: Blob | null = null;
/** Every patient sent in this browser session: the key file always lists all of them. */
const sessionKey: { name: string; id: string; folder: string }[] = [];

// ---- mode banner ----
if (zipMode) {
  const banner = $("mode");
  banner.hidden = false;
  banner.textContent =
    "This browser cannot save into a folder, so results come as one ZIP download. For many patients or videos, use Chrome or Edge.";
}

// ---- folder selection ----
async function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) return all;
    all.push(...batch);
  }
}
async function walk(entry: FileSystemEntry, prefix: string, out: { path: string; file: File }[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    for (const e of await readEntries(entry as FileSystemDirectoryEntry)) await walk(e, prefix + entry.name + "/", out);
  }
}

function setFiles(list: { path: string; file: File }[]) {
  const found = detectPatients(list);
  const ids = assignIds(found.map((p) => p.name), []);
  patients = found.map((p) => ({
    folder: p.name,
    name: p.name,
    extra: "",
    id: ids.get(p.name)!,
    files: p.files.map((f) => ({ relPath: f.relPath, file: f.file })),
  }));
  renderPatients();
}

$<HTMLInputElement>("pick").addEventListener("change", (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  setFiles(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
});

const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const items = Array.from(e.dataTransfer?.items ?? []).map((i) => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  const out: { path: string; file: File }[] = [];
  for (const it of items) await walk(it, "", out);
  // a single dropped folder behaves like selecting it; several dropped folders are wrapped in a virtual root
  setFiles(items.length === 1 ? out : out.map((o) => ({ ...o, path: "Selected/" + o.path })));
});

function renderPatients() {
  $("step-patients").hidden = patients.length === 0;
  const body = $("patients");
  body.replaceChildren();
  patients.forEach((p) => {
    const tr = document.createElement("tr");
    const cell = (child: Node, cls = "") => {
      const td = document.createElement("td");
      td.className = cls;
      td.append(child);
      tr.append(td);
    };
    const name = Object.assign(document.createElement("input"), { type: "text", value: p.name });
    name.addEventListener("input", () => (p.name = name.value));
    const extra = Object.assign(document.createElement("input"), { type: "text", value: p.extra, placeholder: "optional, comma separated" });
    extra.addEventListener("input", () => (p.extra = extra.value));
    cell(name);
    cell(extra);
    cell(document.createTextNode(p.id), "id");
    cell(document.createTextNode(String(p.files.filter((f) => classify(f.file.name) !== "junk").length)));
    body.append(tr);
  });
}

// ---- run ----
function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const keyCsv = () => new Blob([toCsv(sessionKey)], { type: "text/csv" });
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");

$("go").addEventListener("click", async () => {
  // ask where to save first: the picker only opens directly inside the click
  let outDir: FileSystemDirectoryHandle | undefined;
  if (!zipMode) {
    try {
      outDir = await pickDir!({ mode: "readwrite", id: "mammocheck-out" });
    } catch {
      return; // cancelled
    }
  }
  $("step-pick").hidden = true;
  $("step-patients").hidden = true;
  $("step-progress").hidden = false;
  for (const p of patients) sessionKey.push({ name: p.name, id: p.id, folder: p.folder });
  download(keyCsv(), `mammocheck-key-${stamp()}.csv`); // save the key before anything else happens
  const bar = $<HTMLProgressElement>("bar");
  const log = $("log");
  log.replaceChildren();
  $("active").replaceChildren();
  bar.value = 0;
  const active = new Map<string, HTMLElement>();
  const zip = new JSZip();
  let reports: PatientReport[];
  try {
    reports = await runAll(
      patients,
      outDir ? { kind: "dir", dir: outDir } : { kind: "zip", zip },
      (e) => {
        bar.max = Math.max(1, e.total);
        bar.value = e.done;
        if (e.state === "harvesting") {
          $("status").textContent = `${e.done} / ${e.total} files — ${e.patient}: reading documents for name spellings…`;
          return;
        }
        $("status").textContent = `${e.done} / ${e.total} files — ${e.patient}`;
        const key = `${e.patient}/${e.file}`;
        let row = active.get(key);
        if (e.state === "done") {
          row?.remove();
          active.delete(key);
          if (e.result === "dropped") return; // junk (Thumbs.db etc.): not worth listing
          const li = document.createElement("li");
          li.textContent = `${STATUS_TEXT[e.result ?? ""] ?? e.result}  ${e.patient}  ${e.file}`;
          if (e.result === "blocked" || e.result === "failed") li.className = "bad";
          else if (e.result === "skipped") li.className = "warn";
          log.prepend(li);
          return;
        }
        if (!row) {
          row = document.createElement("li");
          $("active").append(row);
          active.set(key, row);
        }
        const what = e.state === "saving" ? (zipMode ? "adding to ZIP…" : "saving…") : "anonymizing…";
        row.textContent = `${e.patient}  ${e.file}  — ${what}`;
      },
    );
  } catch (e) {
    $("status").textContent = `Stopped: ${(e as Error).message}`;
    return;
  }
  if (zipMode) {
    lastZip = await zip.generateAsync({ type: "blob" });
    download(lastZip, `mammocheck-anonymized-${stamp()}.zip`);
  }
  showReport(reports, outDir?.name);
});

const STATUS_TEXT: Record<string, string> = {
  saved: "✓ saved",
  blocked: "⚠ blocked",
  skipped: "– skipped",
  failed: "✗ failed",
};

function showReport(reports: PatientReport[], savedTo?: string) {
  $("step-progress").hidden = true;
  $("step-report").hidden = false;
  $("dlkey").onclick = () => download(keyCsv(), `mammocheck-key-${stamp()}.csv`);
  $("savedto").textContent = savedTo !== undefined
    ? `Anonymized copies were saved in the folder "${savedTo}", one sub-folder per patient ID.`
    : "Anonymized copies were downloaded as a ZIP file (see your Downloads folder).";
  const dz = $("dlzip");
  dz.hidden = !zipMode;
  dz.onclick = () => lastZip && download(lastZip, `mammocheck-anonymized-${stamp()}.zip`);
  const root = $("report");
  const batch = document.createElement("div");
  for (const r of reports) {
    const ok = (e: { status: string }) => e.status === "saved";
    const sent = r.entries.filter(ok).length;
    const bad = r.entries.filter((e) => !ok(e));
    const d = document.createElement("details");
    d.open = bad.length > 0;
    const sum = document.createElement("summary");
    sum.innerHTML = `<strong></strong> &mdash; <span class="ok"></span>${bad.length ? ' <span class="bad"></span>' : ""}`;
    sum.querySelector("strong")!.textContent = `${r.folder} (${r.id})`;
    sum.querySelector(".ok")!.textContent = `${sent} saved`;
    if (bad.length) sum.querySelector(".bad")!.textContent = `${bad.length} not saved`;
    d.append(sum);
    const ul = document.createElement("ul");
    ul.className = "rep";
    // problems first, then everything that went through; junk files (Thumbs.db etc.) are only counted
    for (const e of [...bad, ...r.entries.filter(ok)]) {
      const li = document.createElement("li");
      if (!ok(e)) li.className = e.status === "skipped" ? "warn" : "bad";
      li.textContent = `${STATUS_TEXT[e.status] ?? e.status}  ${e.path}${e.reason ? " (" + e.reason + ")" : ""}`;
      ul.append(li);
    }
    if (r.dropped) {
      const li = document.createElement("li");
      li.textContent = `${r.dropped} system file(s) ignored (Thumbs.db, .DS_Store, …)`;
      ul.append(li);
    }
    d.append(ul);
    batch.append(d);
  }
  root.prepend(batch); // newest run on top, earlier runs stay listed
}

// ---- next batch ----
$("more").addEventListener("click", () => {
  patients = [];
  $<HTMLInputElement>("pick").value = "";
  $("step-patients").hidden = true;
  $("step-pick").hidden = false;
  $("step-pick").scrollIntoView({ behavior: "smooth" });
});
