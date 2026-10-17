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

export function answerFallback(question = '', scene = {}) {
  const normalized = question.toLowerCase();
  if (normalized.includes('won') || normalized.includes('winner')) {
    return { answer: 'I missed the final score. The controllers are refusing to comment.', hotspot: { label: 'screen', box_2d: [180, 250, 480, 750] } };
  }
  if (normalized.includes('window')) {
    return { answer: 'By the window is whatever gets the best natural light and the least attention.', hotspot: null };
  }
  return { answer: `I am still getting settled in ${scene.name || 'here'}. Ask me about something you can see.`, hotspot: null };
}
