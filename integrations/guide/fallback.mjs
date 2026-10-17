export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeFallback() {
  return 'A warm, lived-in room with soft light, practical furniture, and a few personal details. Beyond the frame, continue the same calm layout with matching seating, storage, and a clear path through the space.';
}

export function hotspotsFallback() {
  return [
    { label: 'screen', x: 0.5, y: 0.32, blurb: 'Main character energy' },
    { label: 'controllers', x: 0.43, y: 0.62, blurb: 'Tiny stress machines' },
    { label: 'snacks', x: 0.66, y: 0.68, blurb: 'Morale department' },
  ];
}

export function narrationFallback(scene = {}) {
  return `Welcome to ${scene.name || 'the room'}. It has been expecting you, mostly because nobody moved the snacks.`;
}

// "what is it made of?" asks about a thing, not the outcome
const OUTCOME_QUESTION = /\b(won|win|wins|winning|winner|score|beat|lost|lose|losing|ahead|making|make|made|cooking|cook|cooked|recipe|dish)\b(?!\s+of\b)/;
const words = (value, max = 30) => value.split(/\s+/).filter(Boolean).slice(0, max).join(' ');

export function framesFallback(notes = []) {
  const item = notes.find((entry) => entry.oneLine || entry.outcome);
  return item ? words([item.oneLine, item.outcome].filter(Boolean).map((line) => (/[.!?]$/.test(line) ? line : `${line}.`)).join(' '), 45) : '';
}

export function answerFallback(question = '', scene = {}, notes = []) {
  const normalized = question.toLowerCase();
  const outcome = notes.find((entry) => entry.outcome)?.outcome;
  if (outcome && OUTCOME_QUESTION.test(normalized)) return { answer: words(outcome), hotspot: null };
  if (outcome && !normalized) return { answer: words(`Didn't catch that. Short version: ${outcome}`), hotspot: null };
  if (normalized.includes('won') || normalized.includes('winner')) {
    return { answer: 'I missed the final score. The controllers are refusing to comment.', hotspot: { label: 'screen', box_2d: [180, 250, 480, 750] } };
  }
  if (normalized.includes('window')) {
    return { answer: 'By the window is whatever gets the best natural light and the least attention.', hotspot: null };
  }
  return { answer: `I am still getting settled in ${scene.name || 'here'}. Ask me about something you can see.`, hotspot: null };
}
