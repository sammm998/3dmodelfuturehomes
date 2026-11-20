/** Shared mutable input for the walk controller (written by DOM joystick / keyboard, read every frame). */
export const walkInput = {
  moveX: 0, // strafe -1..1
  moveY: 0, // forward -1..1
  lookX: 0, // yaw velocity from the look joystick
  lookY: 0,
};
