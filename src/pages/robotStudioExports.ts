import type { RobotStudioExportContext, RobotStudioExportHandler } from './robotStudio';
import {
  EXPORT_FORMATS,
  exportAllFormatsZip,
  exportModel,
  saveBlob,
  type ExportFormat,
  type ExportReport,
} from '../exporters';
import { downloadShowcaseSource } from '../source-download';

const EXPORT_SECTION_MARKUP = [
  '      <section class="robot-section robot-export-section" id="robot-export-section" aria-labelledby="robot-export-title">',
  '        <div class="robot-section-heading"><h2 id="robot-export-title">Export</h2><output class="robot-export-status" id="robot-export-status" aria-live="polite" data-state="ready">Waiting for model</output></div>',
  '        <p class="robot-export-intro" id="robot-export-intro">Validate the source mesh and download a portable 3D asset. 3D exports freeze the live pose and disable edits until the file is saved.</p>',
  '        <div class="robot-export-controls">',
  '          <label class="robot-export-format-label" for="robot-export-format-select">Format</label>',
  '          <div class="robot-export-select-row">',
  '            <select id="robot-export-format-select" class="robot-export-select" aria-describedby="robot-export-format-note" disabled></select>',
  '            <button class="robot-export-info" id="robot-export-info" type="button" aria-label="Format portability summary" aria-expanded="false" aria-controls="robot-export-tooltip" disabled>i</button>',
  '          </div>',
  '          <p class="robot-export-format-note" id="robot-export-format-note">Pick a format to see what it keeps and the interchange limits.</p>',
  '          <div class="robot-export-tooltip" id="robot-export-tooltip" role="tooltip" hidden>',
  '            <strong id="robot-export-tooltip-title">Format portability</strong>',
  '            <p><span>Keeps</span><span id="robot-export-tooltip-keeps-text"></span></p>',
  '            <p><span>Limits</span><span id="robot-export-tooltip-limits-text"></span></p>',
  '          </div>',
  '        </div>',
  '        <button class="robot-export-asset" id="robot-export-asset" type="button" disabled>',
  '          <span class="robot-export-asset-label"><span id="robot-export-asset-text">Download selected format</span></span>',
  '          <span class="robot-export-asset-size" id="robot-export-asset-size">Model not ready</span>',
  '        </button>',
  '        <button class="robot-export-zip" id="robot-export-zip" type="button" disabled>',
  '          <span><strong>Export all formats</strong><small id="robot-export-zip-note">6 validated assets + manifest</small></span>',
  '          <span class="robot-export-zip-badge" aria-hidden="true">ZIP bundle</span>',
  '        </button>',
  '        <button class="robot-export-zip robot-export-source" id="robot-export-source" type="button">',
  '          <span><strong>Download source code</strong><small id="robot-export-source-note">Editable TypeScript &middot; animation + VFX preserved &middot; no GLB dependency</small></span>',
  '          <span class="robot-export-zip-badge" aria-hidden="true">Source ZIP</span>',
  '        </button>',
  '        <div class="robot-export-report" id="robot-export-report" hidden>',
  '          <p id="robot-export-summary"></p>',
  '          <ul id="robot-export-warnings"></ul>',
  '        </div>',
  '        <p class="robot-export-fidelity" id="robot-export-fidelity">Live runtime VFX and gesture overlays are not representable in these interchange formats; download the source archive to keep them.</p>',
  '      </section>',
].join('\n');

type ExportState = 'ready' | 'busy' | 'success' | 'warning' | 'error';

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Inject the robot-studio export panel into the host page.
 *
 * The page itself owns the animation-freeze and color/motion disable logic. The panel:
 *   - shows the export section (hidden by default in the studio markup);
 *   - formats the six interchange outputs and a single ZIP bundle;
 *   - downloads the source archive even when the model never finished loading;
 *   - publishes `__IMG2THREEJS_EXPORT__`, `__IMG2THREEJS_LAST_EXPORT_REPORT__`, and
 *     `__IMG2THREEJS_LAST_EXPORT_BUNDLE__` QA hooks the way the generic page does.
 *
 * The handler tears down on dispose, aborting any in-flight source fetch and deleting its
 * globals so a second mount starts clean.
 */
export function mountRobotStudioExports(
  context: RobotStudioExportContext,
): RobotStudioExportHandler {
  const animationSection = context.mount.querySelector<HTMLElement>('.robot-animation-section');
  if (!animationSection) {
    throw new Error('Robot studio export panel needs a `.robot-animation-section` anchor.');
  }
  // Insert the export section ahead of the Motion library block.
  const host = document.createElement('div');
  host.innerHTML = EXPORT_SECTION_MARKUP;
  const exportSection = host.firstElementChild as HTMLElement;
  animationSection.parentElement?.insertBefore(exportSection, animationSection);

  const exportStatus = exportSection.querySelector<HTMLOutputElement>('#robot-export-status');
  const exportFormatSelect = exportSection.querySelector<HTMLSelectElement>('#robot-export-format-select');
  const exportInfoButton = exportSection.querySelector<HTMLButtonElement>('#robot-export-info');
  const exportFormatNote = exportSection.querySelector<HTMLElement>('#robot-export-format-note');
  const exportTooltip = exportSection.querySelector<HTMLElement>('#robot-export-tooltip');
  const exportTooltipTitle = exportSection.querySelector<HTMLElement>('#robot-export-tooltip-title');
  const exportTooltipKeeps = exportSection.querySelector<HTMLElement>('#robot-export-tooltip-keeps-text');
  const exportTooltipLimits = exportSection.querySelector<HTMLElement>('#robot-export-tooltip-limits-text');
  const exportAssetButton = exportSection.querySelector<HTMLButtonElement>('#robot-export-asset');
  const exportAssetText = exportSection.querySelector<HTMLElement>('#robot-export-asset-text');
  const exportAssetSize = exportSection.querySelector<HTMLElement>('#robot-export-asset-size');
  const exportZipButton = exportSection.querySelector<HTMLButtonElement>('#robot-export-zip');
  const exportZipNote = exportSection.querySelector<HTMLElement>('#robot-export-zip-note');
  const exportSourceButton = exportSection.querySelector<HTMLButtonElement>('#robot-export-source');
  const exportSourceNote = exportSection.querySelector<HTMLElement>('#robot-export-source-note');
  const exportReport = exportSection.querySelector<HTMLElement>('#robot-export-report');
  const exportSummary = exportSection.querySelector<HTMLElement>('#robot-export-summary');
  const exportWarnings = exportSection.querySelector<HTMLElement>('#robot-export-warnings');
  if (!exportStatus || !exportFormatSelect || !exportInfoButton || !exportFormatNote || !exportTooltip
    || !exportTooltipTitle || !exportTooltipKeeps || !exportTooltipLimits
    || !exportAssetButton || !exportAssetText || !exportAssetSize
    || !exportZipButton || !exportZipNote || !exportSourceButton || !exportSourceNote
    || !exportReport || !exportSummary || !exportWarnings) {
    throw new Error('Robot studio export panel is missing one of its expected hooks.');
  }

  let selectedExportFormat: ExportFormat = EXPORT_FORMATS[0].format;
  // Single busy gate: every export path (single asset, ZIP bundle, source archive) flips this
  // so a click on one button is rejected while another export is in flight. setAssetBusy is
  // called by the page between true/false; the handler invokes the exporter directly between
  // those two calls.
  let exportBusy = false;
  const sourceAbortController = new AbortController();
  const qaWindow = window as unknown as Record<string, unknown>;
  const cleanups: Array<() => void> = [];

  const setExportStatus = (text: string, state: ExportState): void => {
    if (context.isDisposed()) return;
    exportStatus.value = text;
    exportStatus.dataset.state = state;
  };
  const showReport = (summary: string, warnings: string[]): void => {
    if (context.isDisposed()) return;
    exportSummary.textContent = summary;
    exportWarnings.replaceChildren();
    for (const warning of warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      exportWarnings.appendChild(item);
    }
    exportWarnings.hidden = warnings.length === 0;
    exportReport.hidden = false;
  };
  const clearReport = (): void => {
    exportSummary.textContent = '';
    exportWarnings.replaceChildren();
    exportWarnings.hidden = true;
    exportReport.hidden = true;
  };
  const updateTooltip = (): void => {
    const definition = EXPORT_FORMATS.find((entry) => entry.format === selectedExportFormat) ?? EXPORT_FORMATS[0];
    exportTooltipTitle.textContent = `${definition.label} portability`;
    exportTooltipKeeps.textContent = definition.keeps;
    exportTooltipLimits.textContent = definition.limits;
    exportFormatNote.textContent = definition.note;
  };
  const updateAssetButton = (): void => {
    const definition = EXPORT_FORMATS.find((entry) => entry.format === selectedExportFormat) ?? EXPORT_FORMATS[0];
    exportAssetText.textContent = `Download ${definition.label}`;
  };
  const setExportControlsEnabled = (enabled: boolean): void => {
    const modelReady = context.getRuntime() !== null;
    exportAssetButton.disabled = !enabled || !modelReady;
    exportZipButton.disabled = !enabled || !modelReady;
    exportSourceButton.disabled = !enabled;
    exportFormatSelect.disabled = !enabled || !modelReady;
    exportInfoButton.disabled = !enabled || !modelReady;
  };
  const closeTooltip = (): void => {
    exportTooltip.hidden = true;
    exportInfoButton.setAttribute('aria-expanded', 'false');
  };

  // Populate the format select once; values are static for the lifetime of the studio.
  for (const definition of EXPORT_FORMATS) {
    const option = document.createElement('option');
    option.value = definition.format;
    option.textContent = `${definition.label} — ${definition.note}`;
    exportFormatSelect.appendChild(option);
  }
  exportFormatSelect.value = selectedExportFormat;
  updateTooltip();
  updateAssetButton();

  const onFormatChange = (): void => {
    selectedExportFormat = exportFormatSelect.value as ExportFormat;
    updateTooltip();
    updateAssetButton();
  };
  exportFormatSelect.addEventListener('change', onFormatChange);
  cleanups.push(() => exportFormatSelect.removeEventListener('change', onFormatChange));

  const onInfoClick = (): void => {
    const open = exportTooltip.hidden;
    exportTooltip.hidden = !open;
    exportInfoButton.setAttribute('aria-expanded', String(open));
  };
  exportInfoButton.addEventListener('click', onInfoClick);
  cleanups.push(() => exportInfoButton.removeEventListener('click', onInfoClick));

  const onOutsideClick = (event: MouseEvent): void => {
    if (!(event.target as HTMLElement).closest('.robot-export-tooltip, #robot-export-info')) {
      closeTooltip();
    }
  };
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    closeTooltip();
    if (exportInfoButton.matches(':focus')) exportInfoButton.blur();
  };
  context.mount.addEventListener('click', onOutsideClick);
  context.mount.addEventListener('keydown', onEscape);
  cleanups.push(() => context.mount.removeEventListener('click', onOutsideClick));
  cleanups.push(() => context.mount.removeEventListener('keydown', onEscape));

  const summaryFromReport = (report: ExportReport, label: string): string => {
    const facts: Array<string | null> = [
      `${label} · ${readableBytes(report.bytes)}`,
      `${report.triangleCount.toLocaleString()} triangles`,
      report.jointCount ? `${report.jointCount.toLocaleString()} joints` : null,
      report.sourceAnimationCount
        ? `${report.animationCount}/${report.sourceAnimationCount} clips`
        : null,
      report.textureCount
        ? report.portableTextureCount === report.textureCount
          ? `${report.textureCount.toLocaleString()} textures`
          : `${report.portableTextureCount.toLocaleString()}/${report.textureCount.toLocaleString()} portable textures`
        : null,
      report.vertexColourMeshCount
        ? `${report.vertexColourMeshCount.toLocaleString()} tinted mesh`
        : null,
      report.roundTripValidated ? 'round-trip passed' : null,
    ];
    return facts.filter((fact): fact is string => !!fact).join(' · ');
  };

  const onExportAsset = async (): Promise<void> => {
    if (exportBusy) return;
    const handles = context.getRuntime();
    if (!handles) return;
    const format = selectedExportFormat;
    const definition = EXPORT_FORMATS.find((entry) => entry.format === format) ?? EXPORT_FORMATS[0];
    exportBusy = true;
    setExportControlsEnabled(false);
    exportAssetButton.classList.add('is-exporting');
    clearReport();
    setExportStatus(`Validating ${definition.label}`, 'busy');
    context.setAssetBusy(true);
    try {
      const artifact = await exportModel(handles.displayRoot, format);
      if (context.isDisposed()) return;
      const filename = `${context.demo.id}.${artifact.filenameExtension}`;
      saveBlob(artifact.blob, filename);
      showReport(summaryFromReport(artifact.report, definition.label), artifact.report.warnings);
      exportAssetSize.textContent = readableBytes(artifact.report.bytes);
      setExportStatus(artifact.report.warnings.length ? 'Validated with limits' : 'Validated',
        artifact.report.warnings.length ? 'warning' : 'success');
      qaWindow.__IMG2THREEJS_LAST_EXPORT_REPORT__ = artifact.report;
    } catch (error) {
      if (context.isDisposed()) return;
      const message = error instanceof Error ? error.message : String(error);
      showReport(message, []);
      setExportStatus('Export blocked', 'error');
      console.error(`[export:${context.demo.id}:${format}]`, error);
    } finally {
      context.setAssetBusy(false);
      if (!context.isDisposed()) {
        exportAssetButton.classList.remove('is-exporting');
        setExportControlsEnabled(true);
        exportBusy = false;
      }
    }
  };
  exportAssetButton.addEventListener('click', onExportAsset);
  cleanups.push(() => exportAssetButton.removeEventListener('click', onExportAsset));

  const onExportZip = async (): Promise<void> => {
    if (exportBusy) return;
    const handles = context.getRuntime();
    if (!handles) return;
    exportBusy = true;
    setExportControlsEnabled(false);
    exportZipButton.classList.add('is-exporting');
    clearReport();
    setExportStatus('Bundling formats 1/6', 'busy');
    context.setAssetBusy(true);
    try {
      const bundle = await exportAllFormatsZip(handles.displayRoot, {
        assetId: context.demo.id,
        scopeId: 'robot',
        scopeLabel: 'Man robot studio model',
        snapshot: (work) => work(),
        onProgress: ({ label, index, total }) => {
          if (!context.isDisposed()) setExportStatus(`${label} ${index}/${total}`, 'busy');
        },
      });
      if (context.isDisposed()) return;
      const warnings = [...new Set(bundle.reports.flatMap((report) => report.warnings))];
      const firstReport = bundle.reports[0];
      const triangleCount = firstReport?.triangleCount ?? 0;
      const sharedJoints = firstReport?.jointCount ?? 0;
      const sharedClips = firstReport?.sourceAnimationCount ?? 0;
      const sharedTextures = firstReport?.textureCount ?? 0;
      const tintedMeshes = firstReport?.vertexColourMeshCount ?? 0;
      const summary = [
        `All formats · ${bundle.reports.length} files · manifest.json · ${readableBytes(bundle.blob.size)}`,
        `${triangleCount.toLocaleString()} triangles`,
        sharedJoints ? `${sharedJoints.toLocaleString()} joints` : null,
        sharedClips ? `${sharedClips} clips` : null,
        sharedTextures ? `${sharedTextures.toLocaleString()} textures` : null,
        tintedMeshes ? `${tintedMeshes.toLocaleString()} tinted mesh` : null,
      ].filter((fact): fact is string => !!fact).join(' · ');
      showReport(summary, warnings);
      saveBlob(bundle.blob, bundle.filename);
      setExportStatus(warnings.length ? 'Bundle validated with limits' : 'Bundle validated',
        warnings.length ? 'warning' : 'success');
      qaWindow.__IMG2THREEJS_LAST_EXPORT_BUNDLE__ = {
        bytes: bundle.blob.size,
        filename: bundle.filename,
        files: bundle.files,
        reports: bundle.reports,
      };
    } catch (error) {
      if (context.isDisposed()) return;
      const message = error instanceof Error ? error.message : String(error);
      showReport(message, []);
      setExportStatus('Bundle blocked', 'error');
      console.error(`[export:${context.demo.id}:zip]`, error);
    } finally {
      context.setAssetBusy(false);
      if (!context.isDisposed()) {
        exportZipButton.classList.remove('is-exporting');
        setExportControlsEnabled(true);
        exportBusy = false;
      }
    }
  };
  exportZipButton.addEventListener('click', onExportZip);
  cleanups.push(() => exportZipButton.removeEventListener('click', onExportZip));

  const onExportSource = async (): Promise<void> => {
    if (exportBusy) return;
    exportBusy = true;
    setExportControlsEnabled(false);
    exportSourceButton.classList.add('is-exporting');
    setExportStatus('Fetching source archive', 'busy');
    const signal = sourceAbortController.signal;
    let outcome: 'success' | 'error' | 'aborted' = 'aborted';
    try {
      const result = await downloadShowcaseSource(context.demo.id, signal);
      if (context.isDisposed() || signal.aborted) {
        outcome = 'aborted';
        return;
      }
      saveBlob(result.blob, result.filename);
      if (exportSourceNote) {
        exportSourceNote.textContent = `Source ready · ${readableBytes(result.blob.size)} · animation + VFX preserved · no GLB dependency`;
      }
      showReport(
        `${result.filename} · ${readableBytes(result.blob.size)} · animation + VFX preserved · no GLB loader in archive`,
        [],
      );
      setExportStatus('Source archive ready', 'success');
      outcome = 'success';
    } catch (error) {
      if (context.isDisposed() || signal.aborted) {
        outcome = 'aborted';
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      showReport(message, []);
      setExportStatus('Source blocked', 'error');
      console.error(`[export:${context.demo.id}:source]`, error);
      outcome = 'error';
    } finally {
      // Restore control state without overwriting the success/error status the try/catch already set.
      if (!context.isDisposed()) {
        exportSourceButton.classList.remove('is-exporting');
        setExportControlsEnabled(true);
        if (outcome === 'aborted') {
          setExportStatus('Source ready', 'ready');
        }
      }
      exportBusy = false;
    }
  };
  exportSourceButton.addEventListener('click', onExportSource);
  cleanups.push(() => exportSourceButton.removeEventListener('click', onExportSource));

  // QA hook mirroring the generic page: callers ask for a single-format report without
  // touching the UI. The same exportBusy gate that protects UI clicks protects this path so
  // a QA call cannot interleave its setAssetBusy with a concurrent UI export and split the
  // freeze/release pair.
  const exportForQa = async (format: ExportFormat): Promise<ExportReport> => {
    if (context.isDisposed()) throw new Error('The robot studio route is no longer active.');
    if (exportBusy) throw new Error('Another robot studio export is already in flight.');
    const handles = context.getRuntime();
    if (!handles) throw new Error('The robot model is not ready for export.');
    if (!EXPORT_FORMATS.some((entry) => entry.format === format)) {
      throw new Error(`Unsupported export format: ${String(format)}`);
    }
    exportBusy = true;
    setExportControlsEnabled(false);
    context.setAssetBusy(true);
    try {
      const artifact = await exportModel(handles.displayRoot, format);
      if (context.isDisposed()) throw new Error('The robot studio route changed during export.');
      qaWindow.__IMG2THREEJS_LAST_EXPORT_REPORT__ = artifact.report;
      return artifact.report;
    } finally {
      context.setAssetBusy(false);
      exportBusy = false;
      if (!context.isDisposed()) setExportControlsEnabled(true);
    }
  };
  qaWindow.__IMG2THREEJS_EXPORT__ = exportForQa;

  // Section is rendered visible at mount so the source archive button works before the model
  // loads and after a load failure. The asset/zip controls stay disabled until ready().
  exportSection.hidden = false;

  const ready = (): void => {
    if (context.isDisposed()) return;
    if (exportBusy) {
      // A source download may already be in flight; only refresh the controls we own and
      // leave the in-progress status text alone so the fetch/error outcome survives.
      const handles = context.getRuntime();
      if (handles) {
        const runtime = handles.runtime;
        exportAssetSize.textContent = `${runtime.meshes.length} mesh · ${runtime.clips.length} clips · ${runtime.meshes[0]?.skeleton.bones.length ?? 0} joints`;
        exportZipNote.textContent = '6 validated assets + manifest';
      }
      return;
    }
    exportFormatSelect.disabled = false;
    exportInfoButton.disabled = false;
    setExportControlsEnabled(true);
    const handles = context.getRuntime();
    if (handles) {
      const runtime = handles.runtime;
      exportAssetSize.textContent = `${runtime.meshes.length} mesh · ${runtime.clips.length} clips · ${runtime.meshes[0]?.skeleton.bones.length ?? 0} joints`;
      exportZipNote.textContent = '6 validated assets + manifest';
    }
    setExportStatus('Ready to export', 'ready');
  };

  const dispose = (): void => {
    sourceAbortController.abort();
    for (const cleanup of cleanups) cleanup();
    if (qaWindow.__IMG2THREEJS_EXPORT__ === exportForQa) {
      delete qaWindow.__IMG2THREEJS_EXPORT__;
    }
    delete qaWindow.__IMG2THREEJS_LAST_EXPORT_REPORT__;
    delete qaWindow.__IMG2THREEJS_LAST_EXPORT_BUNDLE__;
    exportSection.remove();
  };

  return { ready, dispose };
}
