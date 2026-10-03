var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// e2e/performance/timeline/session-tab-switch-probe.ts
var exports_session_tab_switch_probe = {};
__export(exports_session_tab_switch_probe, {
  waitForStableTimeline: () => waitForStableTimeline,
  timelineStabilityError: () => timelineStabilityError,
  measureSessionSwitch: () => measureSessionSwitch
});
module.exports = __toCommonJS(exports_session_tab_switch_probe);
var import_test = require("@playwright/test");

// e2e/performance/timeline/session-tab-switch-metrics.ts
function classifySessionSwitch(samples) {
  const firstDestination = samples.findIndex((sample) => sample.destination.length > 0);
  const firstCorrect = samples.findIndex(isCorrectDestination);
  const stable = samples.findIndex((_, index) => isStableSessionSwitch(samples.slice(index, index + 3)));
  return {
    firstDestinationObservedMs: samples[firstDestination]?.observedAtMs ?? null,
    firstCorrectObservedMs: samples[firstCorrect]?.observedAtMs ?? null,
    stableObservedMs: samples[stable + 2]?.observedAtMs ?? null,
    wrongDestinationSamples: samples.slice(firstDestination).filter((sample) => sample.destination.length > 0 && !sample.last).length,
    blankSamples: samples.filter((sample) => !sample.hasVisibleRows).length,
    unknownSamples: samples.filter((sample) => sample.hasVisibleRows && sample.destination.length === 0 && sample.source.length === 0).length,
    sourceSamples: samples.filter((sample) => sample.source.length > 0).length,
    reviewFileHostMissingSamples: samples.filter((sample) => sample.review && !sample.review.fileHost).length,
    reviewFileHostReplacedSamples: samples.filter((sample) => sample.review?.fileHostReplaced).length,
    reviewHeaders: [...new Set(samples.flatMap((sample) => sample.review ? [sample.review.header] : []))],
    reviewReplacedLevels: [...new Set(samples.flatMap((sample) => sample.review?.replacedLevels ?? []))]
  };
}
function isCorrectDestination(sample) {
  return sample.destination.length > 0 && sample.source.length === 0 && sample.last && sample.requiredPartVisible !== false && (sample.bottomAnchorRequired === false || Math.abs(sample.bottomErrorPx ?? Infinity) <= 1);
}
function isStableSessionSwitch(samples) {
  return samples.length === 3 && samples.every(isCorrectDestination);
}
function isStableDestination(samples) {
  return samples.length === 3 && samples.every((sample) => sample.last && Math.abs(sample.bottomErrorPx ?? Infinity) <= 1);
}

// e2e/performance/timeline/session-tab-switch-probe.ts
function timelineStabilityError(lastID, samples, cause) {
  return new Error(`Timeline did not stabilize: lastMessageID=${lastID}, samples=${samples.length}, recent=${JSON.stringify(samples.slice(-3))}`, { cause });
}
async function installSessionSwitchProbe(page, input) {
  await page.evaluate(({ destinationIDs, sourceIDs, lastID, requiredPartID, requireBottomAnchor, href }) => {
    const destination = new Set(destinationIDs);
    const source = new Set(sourceIDs);
    const samples = [];
    let started;
    let running = true;
    const reviewLevels = {
      panel: "#review-panel",
      tabs: '#review-panel [data-component="tabs"]',
      body: '#review-panel [data-slot="session-review-v2-body"]',
      review: '#review-panel [data-component="session-review-v2"]',
      preview: '#review-panel [data-slot="session-review-v2-preview"]',
      scroll: '#review-panel [data-slot="session-review-v2-diff-scroll"]',
      file: '#review-panel [data-component="file"][data-mode="diff"]'
    };
    const initialReviewNodes = {};
    const sample = () => {
      if (!running || started === undefined)
        return;
      setTimeout(() => {
        if (!running || started === undefined)
          return;
        const observedAtMs = performance.now() - started;
        const reviewPanel = document.querySelector("#review-panel");
        const reviewFile = reviewPanel?.querySelector('[data-component="file"][data-mode="diff"]');
        const initialReviewFile = initialReviewNodes.file;
        const replacedLevels = Object.entries(reviewLevels).flatMap(([name, selector]) => {
          const initial = initialReviewNodes[name];
          if (!initial)
            return [];
          const current = document.querySelector(selector);
          return current && current !== initial ? [name] : [];
        });
        const review = reviewPanel ? {
          fileHost: !!reviewFile,
          fileHostReplaced: !!initialReviewFile && !!reviewFile && reviewFile !== initialReviewFile,
          header: reviewPanel.querySelector('[data-slot="session-review-v2-file-header"]')?.textContent?.trim() ?? "",
          replacedLevels
        } : undefined;
        const root = [...document.querySelectorAll(".scroll-view__viewport")].find((element) => element.querySelector("[data-timeline-row]"));
        if (root) {
          const view = root.getBoundingClientRect();
          const visible = [...root.querySelectorAll("[data-message-id]")].filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom > view.top && rect.top < view.bottom;
          }).map((element) => element.dataset.messageId);
          const hasVisibleRows = [...root.querySelectorAll("[data-timeline-key]")].some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom > view.top && rect.top < view.bottom;
          });
          const requiredPartVisible = requiredPartID ? [...root.querySelectorAll("[data-timeline-part-id]")].some((element) => {
            if (element.dataset.timelinePartId !== requiredPartID)
              return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
          }) : undefined;
          const spacer = root.querySelector('[data-timeline-row="bottom-spacer"]')?.getBoundingClientRect();
          samples.push({
            observedAtMs,
            destination: visible.filter((id) => destination.has(id)),
            source: visible.filter((id) => source.has(id)),
            hasVisibleRows,
            last: visible.includes(lastID),
            requiredPartVisible,
            bottomAnchorRequired: requireBottomAnchor !== false,
            bottomErrorPx: spacer ? root.scrollHeight - root.clientHeight - root.scrollTop : undefined,
            review
          });
        } else {
          samples.push({
            observedAtMs,
            destination: [],
            source: [],
            hasVisibleRows: false,
            last: false,
            requiredPartVisible: requiredPartID ? false : undefined,
            bottomAnchorRequired: requireBottomAnchor !== false,
            review
          });
        }
        requestAnimationFrame(sample);
      }, 0);
    };
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a") : undefined;
      if (link?.getAttribute("href") !== href)
        return;
      started = performance.now();
      for (const [name, selector] of Object.entries(reviewLevels)) {
        initialReviewNodes[name] = document.querySelector(selector);
      }
      requestAnimationFrame(sample);
    }, { capture: true, once: true });
    window.__sessionSwitchProbe = {
      samples,
      stop: () => {
        running = false;
      }
    };
  }, input);
}
async function waitForStableSessionSwitch(page, input) {
  await page.waitForFunction(() => {
    const samples = window.__sessionSwitchProbe?.samples;
    if (!samples)
      return false;
    return samples.some((_, index) => {
      const stable = samples.slice(index, index + 3);
      return stable.length === 3 && stable.every((sample) => sample.destination.length > 0 && sample.source.length === 0 && sample.last && sample.requiredPartVisible !== false && (sample.bottomAnchorRequired === false || Math.abs(sample.bottomErrorPx ?? Infinity) <= 1));
    });
  }, undefined, { timeout: 30000 }).catch(async (error) => {
    const diagnostics = await page.evaluate(({ lastID, requiredPartID }) => {
      const probe = window.__sessionSwitchProbe;
      const viewports = [...document.querySelectorAll(".scroll-view__viewport")];
      const root = viewports.find((element) => element.querySelector("[data-timeline-row]"));
      const view = root?.getBoundingClientRect();
      const bounds = (element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const visible = (element) => {
        if (!view)
          return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
      };
      const messages = root ? [...root.querySelectorAll("[data-message-id]")] : [];
      const parts = root ? [...root.querySelectorAll("[data-timeline-part-id]")] : [];
      return {
        sampleCount: probe?.samples.length ?? 0,
        recent: probe?.samples.slice(-3) ?? [],
        viewportCount: viewports.length,
        viewport: root ? {
          ...bounds(root),
          scrollTop: root.scrollTop,
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight
        } : undefined,
        lastMatches: messages.filter((element) => element.dataset.messageId === lastID).map(bounds),
        requiredPartMatches: parts.filter((element) => element.dataset.timelinePartId === requiredPartID).map(bounds),
        visibleMessageIDs: [...new Set(messages.filter(visible).map((element) => element.dataset.messageId))].slice(-64),
        visiblePartIDs: [...new Set(parts.filter(visible).map((element) => element.dataset.timelinePartId))].slice(-64),
        partIDs: [...new Set(parts.map((element) => element.dataset.timelinePartId))].slice(-200)
      };
    }, { lastID: input.lastID, requiredPartID: input.requiredPartID }).catch(() => {
      return;
    });
    if (!diagnostics)
      throw error;
    throw new Error(`Session switch did not stabilize: ${JSON.stringify({ lastID: input.lastID, requiredPartID: input.requiredPartID, ...diagnostics })}`, { cause: error });
  });
}
async function collectSessionSwitchResult(page) {
  const samples = await page.evaluate(() => {
    const probe = window.__sessionSwitchProbe;
    probe.stop();
    return probe.samples;
  });
  return classifySessionSwitch(samples);
}
async function measureSessionSwitch(page, input) {
  const { switch: run, ...probe } = input;
  await installSessionSwitchProbe(page, probe);
  let failed = false;
  try {
    await run();
    await waitForStableSessionSwitch(page, probe);
    return await collectSessionSwitchResult(page);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await page.evaluate(() => {
      window.__sessionSwitchProbe?.stop();
    }).catch((error) => {
      if (!failed)
        throw error;
    });
  }
}
async function waitForStableTimeline(page, lastID) {
  const samples = [];
  await import_test.expect.poll(async () => {
    samples.push(await page.evaluate((lastID2) => new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(() => {
        const viewports = [...document.querySelectorAll(".scroll-view__viewport")];
        const root = viewports.find((element) => element.querySelector("[data-timeline-row]"));
        if (!root) {
          resolve({
            last: false,
            viewportCount: viewports.length,
            timelineRowCount: document.querySelectorAll("[data-timeline-row]").length
          });
          return;
        }
        const view = root.getBoundingClientRect();
        const matching = [...root.querySelectorAll("[data-message-id]")].filter((element) => element.dataset.messageId === lastID2);
        const last = matching.some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > view.top && rect.top < view.bottom;
        });
        const spacer = root.querySelector('[data-timeline-row="bottom-spacer"]')?.getBoundingClientRect();
        resolve({
          last,
          bottomErrorPx: spacer ? root.scrollHeight - root.clientHeight - root.scrollTop : undefined,
          viewportCount: viewports.length,
          timelineRowCount: root.querySelectorAll("[data-timeline-row]").length,
          lastMessageCount: matching.length,
          scrollTop: root.scrollTop,
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight,
          viewportTop: view.top,
          viewportBottom: view.bottom,
          spacerBottom: spacer?.bottom
        });
      }, 0));
    }), lastID));
    return isStableDestination(samples.slice(-3));
  }, { timeout: 30000, intervals: [0] }).toBe(true).catch((error) => {
    throw timelineStabilityError(lastID, samples, error);
  });
}
