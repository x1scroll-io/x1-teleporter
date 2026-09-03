# Teleporter Swap Card — "Teleport Console" Design Direction

## The concept
The swap card is NOT a flat glass rectangle floating on the background. It's a **teleporter control console** — a piece of hardware set INTO the scene, like a spacecraft nav panel you punch your journey coordinates into. You set FROM-chain, TO-chain, token, amount (your "route coordinates"), and hit TELEPORT to fire it.

Mental model: **a premium car's center console or a jet's nav panel** — the HOUSING has real engineered shape (bevels, depth, a bezel, that "device" quality), but the SCREEN/INPUTS inside stay clean and legible. Hardware form on the shell; clean UX on the interface.

## The balance (critical — don't break this)
- **The housing has SHAPE** (hardware, form, depth) → makes it feel premium and on-theme (part of the teleporter world).
- **The inputs stay CLEAN** (readable, simple, Uniswap-legible) → a teenager still uses it effortlessly.
- **Do NOT make the card photorealistic/busy.** Its premium feel comes from CONTRAST: a clean, engineered console against the rich 4K astronaut background. A loud card competes with the background and reads as "trying too hard." Calm console + cinematic world = premium.

## Giving the card shape (the housing)
- **Beveled / chamfered corners** — not a plain rounded rectangle; cut corners at angles, like a metal device panel. Reads as a "unit."
- **A bezel/frame** — a thin metallic or subtly-glowing border (cyan, pulled from the astronaut portal) that reads as device housing — the rim of a console screen.
- **Depth cues:**
  - Input fields look **recessed/inset** (subtle inner shadow) — like physical slots you enter coordinates into.
  - The TELEPORT button looks **raised** (subtle lift/glow) — like a real button you press.
- **A console header strip** — a small label bar reading as equipment (e.g. a thin readout strip, or subtle "ROUTE" / status label). Makes it read as hardware, not a web form.
- **Glass + hardware combined:** backdrop-blur glass fill (so the astronaut glows through subtly) WITHIN a hardware bezel/frame. Glass screen, metal housing.

## Keep the inputs clean (the interface)
- FROM / TO chain pickers = "route coordinates." Lean into nav language subtly: "Set your route," "Destination: X1."
- Token + amount = simple, big, readable.
- Fees shown small, plain language, after quote.
- One clear TELEPORT button (the "fire" action).
- Errors friendly. Big tap targets. Mobile-first.

## Motion (makes it feel like live hardware)
- Numbers tick/count when quoting (like a readout updating).
- Button has a subtle pulse/glow (armed and ready).
- On TELEPORT: the console "fires" → the teleport-sequence video plays (astronaut → transforms → emerges X1-branded).
- Micro-interactions ≤200ms, ease-out. Nothing bounces. No sound.

## Accent & world-cohesion
- Accent = electric cyan from the astronaut portal, so console and background are one world.
- The console bezel glow, the button, the readouts all use that cyan.
- Dark, glassy, premium. The console looks like it BELONGS in the astronaut/portal scene — because it's the control unit FOR the teleport.

## The one-line test
"Does it look like a clean, engineered control console set into a cinematic space scene — hardware you'd trust, easy enough a teenager sets a route and fires it?" If it looks like a busy photorealistic panel fighting the background, pull back. If it looks like a flat rectangle ignoring the scene, add the housing/bevel/depth. The sweet spot: engineered console, clean screen, part of the world.
