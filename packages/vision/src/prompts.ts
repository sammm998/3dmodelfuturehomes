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

export const EXTERIOR_PROMPT = `These photos show the OUTSIDE of one property from a real-estate listing.
Describe the building so it can be modelled in 3D as faithfully as possible:
- storeys: number of storeys above ground visible on the main building (ground floor counts as 1).
- roof shape and material/colour (flat roofs with parapets are common in modern Mediterranean villas).
- wallMaterial + wallColor: the dominant facade finish and its colour (#rrggbb, as seen in daylight, not shadow).
- accentMaterial/accentColor/accentPlacement: a secondary cladding (e.g. natural stone on the ground floor, wood slats around the entrance), or none.
- windowStyle (punched = individual windows, large_glazing = wide glass areas, floor_to_ceiling = full-height glass walls/sliding doors) and frame colour.
- shutters (and colour), balconies (type), roof terrace, pergola, pool, garden.
Only report what you can see. Use the photo where the building is most visible for colours.`;

export const MATERIALS_PROMPT = `Look at this interior photo and describe surface materials for a 3D reconstruction.
floor.kind: wood | tile | stone | concrete | carpet | unknown; floor.colorHex: dominant floor colour as #rrggbb.
wallColorHex: dominant wall paint colour as #rrggbb. style: 2-4 words (e.g. "modern mediterranean").`;
