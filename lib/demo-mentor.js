/* ==========================================================================
   Demo mentor — a small built-in electronics FAQ.
   Used ONLY when the server has no DEEPSEEK_API_KEY, so the app remains
   demonstrable without a paid key. Clearly labelled as demo in the UI.
   Answers intentionally include markdown + LaTeX so the full rendering
   pipeline (marked -> DOMPurify -> KaTeX) is exercised end to end.
   ========================================================================== */

const TOPICS = [
  {
    keys: ['ohm', 'ohms law', 'v=ir', 'voltage current resistance'],
    title: "Ohm's Law",
    answer: `**Ohm's law** relates voltage, current and resistance in a conductor:

$$V = I \\times R$$

Rearranged, it gives you whichever quantity you are missing:

- Current: $I = \\dfrac{V}{R}$
- Resistance: $R = \\dfrac{V}{I}$
- Voltage: $V = I \\times R$

**Worked example.** A $R = 220\\,\\Omega$ resistor across a $V = 5\\,\\text{V}$ supply carries

$$I = \\frac{5}{220} \\approx 0.0227\\,\\text{A} = 22.7\\,\\text{mA}$$

Remember the units: volts (V), amperes (A), ohms ($\\Omega$). If your values are in mA or k$\\Omega$, convert first.`,
  },
  {
    keys: ['resistor colour', 'color code', 'colour code', 'bands', 'read a resistor'],
    title: 'Resistor colour code',
    answer: `A **4-band resistor** reads as: *digit, digit, multiplier, tolerance*.

| Band | Meaning | Example (brown-black-red-gold) |
|---|---|---|
| 1st | 1st digit | brown = 1 |
| 2nd | 2nd digit | black = 0 |
| 3rd | multiplier | red = $\\times 10^2$ |
| 4th | tolerance | gold = $\\pm 5\\%$ |

So brown-black-red-gold is $10 \\times 10^2 = 1000\\,\\Omega = 1\\,\\text{k}\\Omega$, $\\pm 5\\%$.

Digit map: black 0, brown 1, red 2, orange 3, yellow 4, green 5, blue 6, violet 7, grey 8, white 9.

A **5-band** part adds a third digit and uses the 4th band as multiplier, giving tighter tolerance.`,
  },
  {
    keys: ['led', 'light emitting', 'current limiting', 'series resistor for led'],
    title: 'Choosing an LED resistor',
    answer: `An LED needs a **series resistor** to limit current, because an LED behaves like a near-constant voltage drop, not a resistor.

$$R = \\frac{V_{supply} - V_f}{I_f}$$

where $V_f$ is the LED forward voltage and $I_f$ the desired current.

**Example.** A red LED ($V_f = 2.0\\,\\text{V}$, $I_f = 20\\,\\text{mA}$) on a $9\\,\\text{V}$ battery:

$$R = \\frac{9 - 2}{0.020} = 350\\,\\Omega \\;\\Rightarrow\\; \\text{use the next standard value, } 390\\,\\Omega$$

Also check the resistor's power rating: $P = I^2 R = 0.02^2 \\times 390 \\approx 0.16\\,\\text{W}$, so a $0.25\\,\\text{W}$ part is fine.`,
  },
  {
    keys: ['rc', 'time constant', 'capacitor charge', 'tau', 'charging capacitor'],
    title: 'RC time constant',
    answer: `For a resistor charging a capacitor, the **time constant** is

$$\\tau = R \\times C$$

The capacitor voltage rises as

$$V_c(t) = V_{supply}\\left(1 - e^{-t/\\tau}\\right)$$

Useful milestones: after $1\\tau$ it reaches ~63%, after $3\\tau$ ~95%, after $5\\tau$ ~99.3% (treat as fully charged).

**Example.** $R = 10\\,\\text{k}\\Omega$, $C = 100\\,\\mu\\text{F}$ gives $\\tau = 10^4 \\times 10^{-4} = 1\\,\\text{s}$. It is essentially charged after $5\\,\\text{s}$.

The same $\\tau$ governs discharge: $V_c(t) = V_0\\, e^{-t/\\tau}$.`,
  },
  {
    keys: ['capacitor', 'capacitance', 'farad', 'uf', 'microfarad'],
    title: 'Capacitor basics',
    answer: `A capacitor stores charge; its capacitance is

$$C = \\frac{Q}{V}$$

in farads (F). Practical values are $\\mu\\text{F}$, nF and pF.

- **In parallel** capacitances add: $C = C_1 + C_2$.
- **In series** they combine like resistors in parallel: $\\dfrac{1}{C} = \\dfrac{1}{C_1} + \\dfrac{1}{C_2}$.

In DC steady state a capacitor is an **open circuit**; in AC it passes current with reactance

$$X_C = \\frac{1}{2\\pi f C}$$

which falls as frequency rises (so caps block DC but pass AC). Always respect the **polarity** of electrolytics and their voltage rating.`,
  },
  {
    keys: ['kirchhoff', 'kvl', 'kcl', 'loop', 'node law'],
    title: "Kirchhoff's laws",
    answer: `**KCL (current law):** the currents into a node sum to zero — charge is conserved.

$$\\sum I_{in} = \\sum I_{out}$$

**KVL (voltage law):** around any closed loop the voltage rises and drops sum to zero — energy is conserved.

$$\\sum V_{loop} = 0$$

**How to use them.** Pick loop directions, write KVL for each loop using $V = IR$ for each resistor, write KCL at nodes, then solve the simultaneous equations. This is the backbone of mesh and nodal analysis.`,
  },
  {
    keys: ['voltage divider', 'potential divider', 'divider'],
    title: 'Voltage divider',
    answer: `Two series resistors split a supply voltage proportionally:

$$V_{out} = V_{in} \\times \\frac{R_2}{R_1 + R_2}$$

where $R_2$ is the resistor across the output.

**Caveat (loading):** this is only accurate if the output draws negligible current. If you attach a load $R_L$, it sits in parallel with $R_2$, so replace $R_2$ with $R_2 \\parallel R_L = \\dfrac{R_2 R_L}{R_2 + R_L}$ first.

Dividers are great for setting a reference or scaling a sensor, but poor for delivering power.`,
  },
  {
    keys: ['power', 'watt', 'watts', 'dissipation', 'p=i', 'heat'],
    title: 'Electrical power',
    answer: `Power dissipated in a component is

$$P = V \\times I$$

and, substituting Ohm's law,

$$P = I^2 R = \\frac{V^2}{R}$$

**Why it matters:** every resistor and IC has a power rating. Exceed it and the part overheats and fails.

**Example.** $100\\,\\Omega$ carrying $50\\,\\text{mA}$ dissipates $P = 0.05^2 \\times 100 = 0.25\\,\\text{W}$ — right at a quarter-watt rating, so choose $0.5\\,\\text{W}$ for margin.`,
  },
  {
    keys: ['series', 'parallel', 'combine', 'equivalent resistance'],
    title: 'Series vs parallel resistors',
    answer: `**Series:** same current flows; resistances add.

$$R = R_1 + R_2 + \\dots$$

**Parallel:** same voltage across each; conductances add.

$$\\frac{1}{R} = \\frac{1}{R_1} + \\frac{1}{R_2} + \\dots \\quad\\text{(two: } R = \\frac{R_1 R_2}{R_1 + R_2}\\text{)}$$

A parallel combination is always *smaller* than the smallest branch. Two equal resistors in parallel give half the value.`,
  },
  {
    keys: ['multimeter', 'measure', 'probe', 'continuity', 'how do i measure'],
    title: 'Using a multimeter',
    answer: `Quick guide:

1. **Voltage (V):** probes *across* the component (parallel). Start on the highest range.
2. **Current (A):** the meter goes *in series* with the circuit — never across a supply, or you blow the fuse.
3. **Resistance / continuity:** power **off**, component isolated; continuity beeps near $0\\,\\Omega$.
4. Black probe to **COM**, red to V/$\\Omega$/mA as marked.

Always double-check the dial before connecting — measuring voltage while set to current is the classic way to destroy a meter.`,
  },
  {
    keys: ['transistor', 'bjt', 'mosfet', 'switch', 'base', 'gate'],
    title: 'Transistor as a switch',
    answer: `A BJT used as a switch operates in **cut-off** (off) or **saturation** (on).

Drive the base so $I_B \\ge \\dfrac{I_C}{\\beta}$ with margin (use forced $\\beta \\approx 10$):

$$R_B = \\frac{V_{drive} - V_{BE}}{I_B}, \\quad V_{BE} \\approx 0.7\\,\\text{V}$$

**Example.** Switching $I_C = 100\\,\\text{mA}$ from a $5\\,\\text{V}$ pin: $I_B = 10\\,\\text{mA}$, so $R_B = (5 - 0.7)/0.010 = 430\\,\\Omega$.

A **MOSFET** switch instead needs a gate voltage above $V_{GS(th)}$ and draws almost no steady gate current — better for high-side or high-current loads.`,
  },
  {
    keys: ['diode', 'rectifier', 'forward voltage', 'bridge'],
    title: 'Diode basics',
    answer: `A diode conducts one way. It has a forward drop $V_f$ (~0.7 V for silicon, ~0.3 V for Schottky) and blocks reverse voltage up to its rating.

Uses:

- **Protection:** series diode against reverse polarity; flyback diode across inductive loads.
- **Rectification:** a bridge of four diodes turns AC into pulsing DC; add a smoothing capacitor.

When switching inductive loads (relay, motor), always place a **flyback diode** reverse-biased across the coil to absorb the $V = L\\,\\frac{di}{dt}$ spike.`,
  },
];

const HELP_INDEX = TOPICS.map((t) => `- **${t.title}**`).join('\n');

const FALLBACK = `I'm running in **demo mode** (no DeepSeek API key on this server), so I only know a handful of topics well. I couldn't match your question to one of them.

I can currently explain:

${HELP_INDEX}

Try asking, for example, *"what resistor do I need for a 2 V LED on a 9 V supply?"*

Set \`DEEPSEEK_API_KEY\` on the server to switch to the full language-model tutor.`;

/** Pick the best-matching topic for the conversation's last user message. */
export function answerFor(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const q = (lastUser?.content || '').toLowerCase();
  if (!q.trim()) return FALLBACK;

  let best = null; let bestScore = 0;
  for (const topic of TOPICS) {
    let score = 0;
    for (const key of topic.keys) if (q.includes(key)) score += key.length; // longer key = stronger signal
    if (score > bestScore) { bestScore = score; best = topic; }
  }
  return best ? best.answer : FALLBACK;
}
