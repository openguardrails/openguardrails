/**
 * Browser half of @openguardrails/dsh-auto-mode — the Auto Mode icon.
 *
 * dsh's Permissions selector draws its shield glyphs from a client-side
 * design set keyed by preset value; a preset a bundle adds gets none. There
 * is no extension seat for glyphs (and this package changes no dsh code), so
 * this module decorates the DOM instead: wherever the composer's permission
 * menu renders the Auto Mode row — or its trigger shows Auto Mode as the
 * current preset — a shield-with-spark SVG in the exact design-set geometry
 * (same outline path, same stroke, `currentColor`) is inserted where the
 * sibling rows carry theirs.
 *
 * Anchoring, precisely:
 *  - The unit of decoration is the INNERMOST element whose exact trimmed
 *    text is the preset label; the dedupe mark lives on that element, so no
 *    matter how many sweeps run, one label instance gets one icon.
 *  - A menu row is decorated only when a sibling subtree carries the
 *    design-set shield (the outline path is the fingerprint), and the icon
 *    is inserted by MIRRORING that sibling: same depth, same child index,
 *    cloned icon container — hashed CSS-module classes come along without
 *    this module knowing them, and the icon lands in the slot, never in a
 *    wrapper above it.
 *  - The trigger is identified by its `title` — the preset DESCRIPTION this
 *    same package configures — not by guessing at markup.
 *  - Everything is marked, idempotent, and removed on dispose; any
 *    structural surprise means "no icon", never a broken UI.
 */

/** The design-set shield outline — the fingerprint of a permission glyph. */
const SHIELD_PREFIX = "M8.20554 0.899994"

/** The label this bundle's cordis.patch.yml gives the preset. */
const AUTO_LABEL = "Auto Mode by OGR"

/** The preset description (trigger `title`) from the same patch — ours, so stable. */
const AUTO_DESCRIPTION_PREFIX = "OpenGuardrails answers approval prompts"

/** Marks every node this module inserts. */
const MARK = "data-ogr-auto-glyph"

/** Marks a label element already handled (the dedupe anchor). */
const DONE = "data-ogr-auto-done"

/** How far above a label the row/trigger structure can reasonably sit. */
const MAX_CLIMB = 4

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

function sparkNode(): Element {
  const holder = document.createElement("span")
  holder.innerHTML = SPARK_SVG
  return holder.firstElementChild as Element
}

/**
 * The icon slot of a design-set glyph: the svg's own wrapper when it has one
 * to itself, else the svg element directly.
 */
function iconSlotOf(shieldPath: Element): Element | undefined {
  const svg = shieldPath.closest("svg")
  if (!svg) return undefined
  const parent = svg.parentElement
  return parent !== null && parent.childElementCount === 1 ? parent : svg
}

/** The spark in the sibling slot's clothes (cloned classes), marked. */
function sparkLike(template: Element): Element {
  let node: Element
  if (template.tagName.toLowerCase() === "svg") {
    node = sparkNode()
    const cls = template.getAttribute("class")
    if (cls !== null) node.setAttribute("class", cls)
  } else {
    node = template.cloneNode(false) as Element
    node.innerHTML = SPARK_SVG
  }
  node.setAttribute(MARK, "")
  node.setAttribute("aria-hidden", "true")
  return node
}

/** Innermost elements whose exact trimmed text is the Auto label. */
function labelElements(): Element[] {
  const result: Element[] = []
  for (const el of document.body.querySelectorAll("*")) {
    if (el.hasAttribute(MARK) || el.textContent?.trim() !== AUTO_LABEL) continue
    let innermost = true
    for (const child of el.children) {
      if (child.textContent?.trim() === AUTO_LABEL) {
        innermost = false
        break
      }
    }
    if (innermost) result.push(el)
  }
  return result
}

/**
 * Menu case: climb from the label; at the level whose siblings carry a
 * design-set shield, mirror that sibling's slot position into our subtree.
 * @returns true when an icon was inserted.
 */
function decorateMenuRow(label: Element): boolean {
  const chain: Element[] = [label]
  for (let depth = 0; depth < MAX_CLIMB; depth += 1) {
    const node = chain[chain.length - 1] as Element
    const parent = node.parentElement
    if (!parent || parent.tagName === "BODY") return false
    for (const sibling of parent.children) {
      if (sibling === node) continue
      const shield = sibling.querySelector(`path[d^="${SHIELD_PREFIX}"]`)
      if (!shield) continue
      const slot = iconSlotOf(shield)
      const slotParent = slot?.parentElement
      if (!slot || !slotParent) continue
      // Depth of the slot's parent below the sibling (0 = direct child).
      let below = 0
      let cursor: Element | null = slotParent
      while (cursor && cursor !== sibling) {
        below += 1
        cursor = cursor.parentElement
      }
      if (cursor === null) continue
      // The corresponding container on our side, at the same depth.
      const target = chain[chain.length - 1 - below]
      if (target === undefined) continue
      const index = Array.prototype.indexOf.call(slotParent.children, slot)
      const anchor = target.children[index] ?? target.firstChild
      target.insertBefore(sparkLike(slot), anchor ?? null)
      return true
    }
    chain.push(parent)
  }
  return false
}

/** Trigger case: the chip whose `title` is this preset's own description. */
function decorateTrigger(label: Element): boolean {
  const button = label.closest("button")
  if (!button || !button.title.startsWith(AUTO_DESCRIPTION_PREFIX)) return false
  if (button.querySelector(`[${MARK}]`)) return true
  const holder = document.createElement("span")
  holder.setAttribute(MARK, "")
  holder.setAttribute("aria-hidden", "true")
  holder.style.display = "inline-flex"
  holder.style.flex = "none"
  holder.style.marginRight = "6px"
  holder.innerHTML = SPARK_SVG
  label.parentElement?.insertBefore(holder, label)
  return true
}

function sweep(): void {
  try {
    for (const label of labelElements()) {
      if (label.hasAttribute(DONE)) {
        // A re-render may keep the label element but drop our foreign node;
        // re-arm when the icon is gone from the label's vicinity.
        const near = label.parentElement?.parentElement ?? label.parentElement
        if (near?.querySelector(`[${MARK}]`)) continue
        label.removeAttribute(DONE)
      }
      if (decorateMenuRow(label) || decorateTrigger(label)) label.setAttribute(DONE, "")
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
      for (const node of document.querySelectorAll(`[${DONE}]`)) node.removeAttribute(DONE)
    }
  }, "openguardrails: Auto Mode permission glyph")
}

export default { name, apply }
