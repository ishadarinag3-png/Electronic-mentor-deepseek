/* ==========================================================================
   Starter prompt library — curated, curriculum-aligned openers.
   Shared by the browser (suggestion chips) and the tests (which assert every
   starter actually yields an answer in demo mode, so there are no dead chips).
   Kept DOM-free so Node can import it.
   ========================================================================== */

export const STARTERS = [
  { id: 'ohm',        label: "Ohm's law",
    text: "State Ohm's law and show me a worked example with numbers." },
  { id: 'led',        label: 'LED resistor',
    text: 'What series resistor do I need for a 2 V LED on a 9 V supply?' },
  { id: 'colour',     label: 'Colour code',
    text: 'How do I read a 4-band resistor colour code? Give an example.' },
  { id: 'rc',         label: 'RC time constant',
    text: 'Explain the RC time constant with a formula and a charging example.' },
  { id: 'capacitor',  label: 'Capacitors',
    text: 'How do capacitors combine in series and parallel, and what is reactance?' },
  { id: 'kirchhoff',  label: "Kirchhoff's laws",
    text: "Explain Kirchhoff's voltage and current laws and how to apply them." },
  { id: 'divider',    label: 'Voltage divider',
    text: 'Derive the voltage divider formula and explain loading effects.' },
  { id: 'power',      label: 'Power ratings',
    text: 'How do I calculate power dissipation and pick a resistor wattage?' },
  { id: 'seriespar',  label: 'Series vs parallel',
    text: 'What is the difference between series and parallel resistors?' },
  { id: 'multimeter', label: 'Multimeter basics',
    text: 'How do I measure voltage, current and continuity with a multimeter?' },
  { id: 'transistor', label: 'Transistor switch',
    text: 'How do I use a transistor as a switch and choose the base resistor?' },
  { id: 'diode',      label: 'Diodes & flyback',
    text: 'What does a diode do and why do inductive loads need a flyback diode?' },
];
