import { Camera, Cartesian3, Matrix3, Matrix4, Quaternion, Transforms, Math as CMath } from "cesium";

/**
 * Orientation for a model whose nose points along +X, left wing along +Y and up along +Z
 * (Cesium's model frame). Built from an explicit east-north-up basis so it does not depend on
 * heading/pitch/roll sign conventions. track: degrees clockwise from north; pitch: +nose up;
 * roll: +right wing down.
 */
export function attitudeQuaternion(position: Cartesian3, trackDeg: number, pitchDeg: number, rollDeg: number): Quaternion {
  const psi = CMath.toRadians(trackDeg), th = CMath.toRadians(pitchDeg), ph = CMath.toRadians(rollDeg);
  const f = [Math.sin(psi) * Math.cos(th), Math.cos(psi) * Math.cos(th), Math.sin(th)];
  const rl = Math.hypot(f[1], f[0]) || 1;
  const r0 = [f[1] / rl, -f[0] / rl, 0]; // horizontal right = forward x up
  const u0 = [r0[1] * f[2] - r0[2] * f[1], r0[2] * f[0] - r0[0] * f[2], r0[0] * f[1] - r0[1] * f[0]]; // right x forward
  const c = Math.cos(ph), s = Math.sin(ph);
  const right = r0.map((v, i) => v * c - u0[i] * s);
  const up = u0.map((v, i) => v * c + r0[i] * s);
  const enuBasis = Matrix3.fromColumnMajorArray([...f, ...right.map((v) => -v), ...up]);
  const rot = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position), new Matrix3());
  return Quaternion.fromRotationMatrix(Matrix3.multiply(rot, enuBasis, new Matrix3()));
}

export type FollowMode = "chase" | "cockpit" | "side" | "top";

/**
 * Place the camera relative to an aircraft (position `p`, model-frame orientation `q`).
 * chase: behind and above; cockpit: at the nose, rolling with the aircraft; side: off the left wing;
 * top: straight down, north up.
 */
export function applyCameraMode(camera: Camera, mode: FollowMode, p: Cartesian3, q: Quaternion): void {
  const rot = Matrix3.fromQuaternion(q);
  const fwd = Matrix3.getColumn(rot, 0, new Cartesian3());
  const left = Matrix3.getColumn(rot, 1, new Cartesian3());
  const up = Matrix3.getColumn(rot, 2, new Cartesian3());
  const worldUp = Cartesian3.normalize(p, new Cartesian3());
  const at = (...terms: [Cartesian3, number][]) =>
    terms.reduce((acc, [v, k]) => Cartesian3.add(acc, Cartesian3.multiplyByScalar(v, k, new Cartesian3()), acc), Cartesian3.clone(p));
  const look = (from: Cartesian3, to: Cartesian3) => Cartesian3.normalize(Cartesian3.subtract(to, from, new Cartesian3()), new Cartesian3());

  if (mode === "cockpit") {
    camera.setView({ destination: at([fwd, 24], [up, 4]), orientation: { direction: fwd, up } });
  } else if (mode === "chase") {
    const from = at([fwd, -140], [worldUp, 40]);
    camera.setView({ destination: from, orientation: { direction: look(from, at([fwd, 70])), up: worldUp } });
  } else if (mode === "side") {
    const from = at([left, 150], [worldUp, 25]);
    camera.setView({ destination: from, orientation: { direction: look(from, p), up: worldUp } });
  } else {
    const east = Cartesian3.normalize(new Cartesian3(-p.y, p.x, 0), new Cartesian3());
    const north = Cartesian3.cross(worldUp, east, new Cartesian3());
    camera.setView({
      destination: at([worldUp, 280]),
      orientation: { direction: Cartesian3.negate(worldUp, new Cartesian3()), up: north },
    });
  }
}
