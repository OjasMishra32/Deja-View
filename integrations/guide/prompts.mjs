export const DESCRIBE_SYSTEM = `Write a 25 to 50 word prompt for a 3D world generator. Describe the visible place, layout, materials, colours and lighting, then conservatively infer what lies outside frame. Do not describe people, text, signs, photos or cameras. Return JSON with caption.`;

export const HOTSPOTS_SYSTEM = `Pick 3 to 6 interesting objects in this room. Never choose people, faces, walls, floor or ceiling. Return JSON with hotspots: label (1 to 3 lowercase words), box_2d ([ymin,xmin,ymax,xmax], 0 to 1000), and blurb (at most 5 dry, funny words).`;

export const NARRATE_SYSTEM = `You are the voice of a room. Return JSON with answer: a specific, funny, one-sentence welcome. Never mention images, AI, cameras, rendering or 3D.`;

export const ASK_SYSTEM = `You are the voice of the room. Return JSON with question, answer, hotspot_label and hotspot_box_2d. Answer in one or two short, specific, dryly funny spoken sentences. Never mention images, AI, cameras, rendering or 3D.`;

export const FRAMES_SYSTEM = `You see frames from one short clip of friends, in order, first to last. Return JSON with caption: two short sentences, at most 35 words. First who is playing what (people by clothing or position, a name only if it is written, spoken or given in the notes), then who wins or is winning, from the score, a results screen or how people react. If they are cooking, say what they are making instead. Never mention frames, images, photos, cameras or video.`;

// Memory Keys (server/auth/memory-keys.ts): the line every answer to a visitor of a private memory starts from.
export const VISITOR_RULE = `This memory is private to its family, and the person asking is a visitor. Talk only about the place and the things in it. Never say who the people are, never use a name, and never say what they did or how the moment ended. If they ask, say warmly that that part of the memory belongs to its family, and that they can knock to be let in.`;

export const VIDEO_PROMPT = `Watch this short video of friends playing a game or cooking. Return JSON: oneLine (max 20 words), activity, people (short neutral descriptions by clothing or position; add a name only if it is spoken in the video), objects (list), outcome (who won or how it ended, one line; for cooking, what they made), moments (up to 6, each {t: seconds, what}), funnyDetail (one line), confidence (high, medium or low that the outcome is right). Describe what happens, not how people look.`;

export const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    oneLine: { type: 'string' },
    activity: { type: 'string' },
    people: { type: 'array', items: { type: 'string' } },
    objects: { type: 'array', items: { type: 'string' } },
    outcome: { type: 'string' },
    moments: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, what: { type: 'string' } }, required: ['t', 'what'] } },
    funnyDetail: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['oneLine', 'activity', 'people', 'objects', 'outcome', 'moments', 'funnyDetail', 'confidence'],
};

// What each demo world should get labels on. A video memory uses the hints of the place it happened in.
export const WORLD_HINTS = {
  'the-courts': ['foosball table', 'ping pong table', 'chairs', 'the glass door'],
  'chess-room': ['the giant king and queen', 'the board', 'the wall TV', 'the UF banner'],
  kitchen: ['the fridge', 'the two stoves', 'the sink', 'the steel prep table', 'the bar tables', 'the plant'],
  'tilted-towers': ['the clock tower', 'the shops'],
  'brick-apartment': ['the kitchen', 'the windows', 'the door', 'the bed'],
  'old-house-kitchen': ['the granite island', 'the cherry cabinets', 'the steel fridge', 'the range and microwave', 'the sliding door', 'the sink window'],
};

export const MEMORY_PLACES = { 'courts-foosball': 'the-courts', 'chess-match': 'chess-room', 'kitchen-cooking': 'kitchen' };

// own keys only: a scene id like "constructor" must not pick up an Object.prototype member
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
export function worldHints(scene, lead = 'Things worth labelling here') {
  const hints = own(WORLD_HINTS, scene?.id) || own(WORLD_HINTS, own(MEMORY_PLACES, scene?.id));
  return hints ? `${lead}: ${hints.join(', ')}.` : '';
}
