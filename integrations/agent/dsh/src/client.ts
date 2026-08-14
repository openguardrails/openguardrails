/**
 * Browser half of @openguardrails/dsh-auto-mode — the Auto Mode icon.
 *
 * dsh's Permissions selector draws its shield glyphs from a client-side
 * design set keyed by preset value; a preset a bundle adds gets none. There
 * is no extension seat for glyphs (and this package changes no dsh code), so
 * this module decorates the DOM instead: wherever the composer's permission
 * menu renders the "Auto Mode" row — or its trigger shows Auto Mode as the
 * current preset — a shield-with-spark SVG in the exact design-set geometry
 * (same outline path, same stroke, `currentColor`) is inserted the way the
 * sibling rows carry theirs.
 *
 * Deliberately defensive and self-limiting:
 *  - A menu row is decorated only when a SIBLING row carries the design-set
 *    shield (the outline path is the fingerprint), so ordinary text that
 *    happens to say "Auto Mode" is never touched. The sibling's icon
 *    container is cloned, so hashed CSS-module classes come along without
 *    this module knowing them.
 *  - The trigger is identified by its `title` — the preset DESCRIPTION this
 *    same package configures — not by guessing at markup.
 *  - Everything is marked, idempotent, and removed on dispose; any structural
 *    surprise means "no icon", never a broken UI.
 */

/** The design-set shield outline — the fingerprint of a permission glyph. */
const SHIELD_PREFIX = "M8.20554 0.899994"

/** The label this bundle's cordis.patch.yml gives the preset. */
const AUTO_LABEL = "Auto Mode"

/** The preset description (trigger `title`) from the same patch — ours, so stable. */
const AUTO_DESCRIPTION_PREFIX = "OpenGuardrails answers approval prompts"

/** Marks every node this module inserts, for idempotence and removal. */
const MARK = "data-ogr-auto-glyph"

/** Shield + four-point spark, design-set geometry, tinted by currentColor. */
const SPARK_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + `<path d="${SHIELD_PREFIX}L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z" stroke="currentColor" stroke-width="1.31831" stroke-linejoin="round"/>`
  + '<path d="M8.20554 4.3999C8.62784 6.42417 9.68127 7.47761 11.7055 7.8999C9.68127 8.3222 8.62784 9.37563 8.20554 11.3999C7.78325 9.37563 6.72981 8.3222 4.70554 7.8999C6.72981 7.47761 7.78325 6.42417 8.20554 4.3999Z" fill="currentColor"/>'
  + "</svg>"

/** The minimal cordis face this plugin touches (no client-runtime import — the bundle stays dependency-free). */
interface ClientContextFace {
  effect(callback: () => () => void, label?: string): void
}

function svgNode(): Element {
  const holder = document.createElement("span")
  holder.innerHTML = SPARK_SVG
  return holder.firstElementChild as Element
}

/**
 * The icon slot of a design-set row: the shield svg's own wrapper when it has
 * one to itself, else the svg element directly.
 */
function iconSlotOf(shieldPath: Element): Element | undefined {
  const svg = shieldPath.closest("svg")
  if (!svg) return undefined
  const parent = svg.parentElement
  return parent !== null && parent.childElementCount === 1 ? parent : svg
}

/** Decorate the Auto Mode row of one menu that provably renders design-set glyphs. */
function decorateMenuRow(shieldPath: Element): void {
  const slot = iconSlotOf(shieldPath)
  if (!slot) return
  // The row is the menu-container child holding this glyph; its siblings are
  // the other rows. Walk up to the element whose parent also contains a row
  // whose text is exactly the Auto label.
  let row: Element | null = slot
  let autoRow: Element | undefined
  while (row && row.parentElement) {
    const parent: Element = row.parentElement
    for (const sibling of parent.children) {
      if (sibling === row) continue
      if (sibling.textContent?.trim() === AUTO_LABEL && !sibling.querySelector("svg")) {
        autoRow = sibling
        break
      }
    }
    if (autoRow) break
    row = parent
    // A permission menu is shallow; give up before leaving the popup.
    if (row.tagName === "BODY") return
  }
  if (!autoRow || autoRow.querySelector(`[${MARK}]`)) return

  // Carry the sibling's icon container (hashed classes included), swap the art.
  const clone = slot.cloneNode(false) as Element
  clone.setAttribute(MARK, "")
  clone.setAttribute("aria-hidden", "true")
  if (clone.tagName.toLowerCase() === "svg") {
    const fresh = svgNode()
    const cls = slot.getAttribute("class")
    if (cls !== null) fresh.setAttribute("class", cls)
    fresh.setAttribute(MARK, "")
    autoRow.insertBefore(fresh, autoRow.firstChild)
  } else {
    clone.innerHTML = SPARK_SVG
    autoRow.insertBefore(clone, autoRow.firstChild)
  }
}

/** Decorate the permission trigger while Auto Mode is the current preset. */
function decorateTrigger(button: Element): void {
  if (button.querySelector(`[${MARK}]`) || button.querySelector(`path[d^="${SHIELD_PREFIX}"]`)) return
  const holder = document.createElement("span")
  holder.setAttribute(MARK, "")
  holder.setAttribute("aria-hidden", "true")
  holder.style.display = "inline-flex"
  holder.style.flex = "none"
  holder.innerHTML = SPARK_SVG
  button.insertBefore(holder, button.firstChild)
}

function sweep(): void {
  try {
    for (const path of document.querySelectorAll(`path[d^="${SHIELD_PREFIX}"]`)) {
      decorateMenuRow(path)
    }
    for (const button of document.querySelectorAll(`button[title^="${AUTO_DESCRIPTION_PREFIX}"]`)) {
      if (button.textContent?.includes(AUTO_LABEL)) decorateTrigger(button)
    }
  } catch {
    // A structural surprise means "no icon this frame", never a broken UI.
  }
}

export const name = "openguardrails-auto-glyph"

/**
 * Install the decorator: one observer, coalesced to a frame, disposed with
 * the plugin (icons removed so a reload starts clean).
 */
export function apply(ctx: ClientContextFace): void {
  ctx.effect(() => {
    let scheduled = false
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        sweep()
      })
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove()
    }
  }, "openguardrails: Auto Mode permission glyph")
}

export default { name, apply }
