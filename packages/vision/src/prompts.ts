export const CLASSIFY_PROMPT = `You classify a single real-estate listing image.
Classes:
- exterior: the building seen from outside (facade, garden, street view of the property, drone shot of the building)
- interior: inside a home; set roomType (living, kitchen, dining, bedroom, bathroom, wc, hall, office, storage, laundry, terrace, balcony, garage, stairs, other)
- floorplan: an architectural plan/drawing of a layout (2D or 3D plan). Set levelHint if the plan names its level ("Ground floor", "First floor", "Level 2", "Basement"...)
- view: a view FROM the property (sea, city, mountains) where the property itself is not the subject
- amenity: shared facilities: pool, gym, rooftop, garden, spa, parking, lobby (set amenity)
- other: logos, maps, people, text-only graphics, renders of unrelated things
Covered terraces/balconies with furniture count as interior with roomType terrace/balcony.
Caption: one short factual sentence (max 15 words). Confidence 0..1.`;

export const FLOORPLAN_PROMPT = `You read an architectural floor plan image for a property listing.
Return:
- isFloorplan: false if this is not a floor plan.
- levelHint / levelIndex: which storey this plan shows (0 = ground floor, 1 = first upper floor, -1 = basement); null if not stated.
- totalAreaM2: total area printed on the plan (convert sq ft to m² by * 0.0929), else null.
- ceilingHeightM if printed.
- multiUnit: true if the drawing shows several separate apartments.
- rooms: every labelled room or space. name = the label as printed (translate to English if needed), type = closest room type,
  cx/cy = the approximate centre of that room in the image, normalised to 0..1 (x to the right, y downwards),
  areaM2 if printed for that room, widthM/depthM if printed dimensions (e.g. "4.20 x 3.50 m", or feet/inches converted).
Be precise with positions: they are used to label geometry detected by computer vision.`;

export const MATCH_PROMPT = (rooms: { id: string; name: string; type: string }[]) =>
  `This photo was taken inside a property. Which of these rooms does it most likely show?
Rooms (id: name [type]):
${rooms.map((r) => `- ${r.id}: ${r.name} [${r.type}]`).join("\n")}
Return roomId = one of the ids above, or null if none fits. Confidence 0..1. Short reason.`;

export const MATERIALS_PROMPT = `Look at this interior photo and describe surface materials for a 3D reconstruction.
floor.kind: wood | tile | stone | concrete | carpet | unknown; floor.colorHex: dominant floor colour as #rrggbb.
wallColorHex: dominant wall paint colour as #rrggbb. style: 2-4 words (e.g. "modern mediterranean").`;
