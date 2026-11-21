interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point];

interface Rectangle {
  ux: number;
  uy: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function cross(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// Points enter in (y, x) order. Only the two extreme points in each row
// can be vertices of the component's convex hull.
function convexHull(points: Point[]) {
  const hull: Point[] = [];
  for (const point of points) {
    while (
      hull.length >= 2 &&
      cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0
    )
      hull.pop();
    hull.push(point);
  }
  const lower = hull.length;
  for (let i = points.length - 2; i >= 0; i--) {
    const point = points[i];
    while (
      hull.length > lower &&
      cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0
    )
      hull.pop();
    hull.push(point);
  }
  hull.pop();
  return hull;
}

function minimumRectangle(hull: Point[]) {
  let best: Rectangle | undefined;
  let area = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    // Use the more horizontal edge for the local x axis, pointing right.
    if (Math.abs(dy) > Math.abs(dx)) [dx, dy] = [-dy, dx];
    const length = Math.sign(dx) * Math.hypot(dx, dy);
    const ux = dx / length;
    const uy = dy / length;
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = p.y * ux - p.x * uy;
      if (u < left) left = u;
      if (u > right) right = u;
      if (v < top) top = v;
      if (v > bottom) bottom = v;
    }
    const candidateArea = (right - left) * (bottom - top);
    if (candidateArea < area) {
      area = candidateArea;
      best = { ux, uy, left, right, top, bottom };
    }
  }
  return best;
}

function quad({ ux, uy, left, right, top, bottom }: Rectangle): Quad {
  const point = (u: number, v: number): Point => ({
    x: u * ux - v * uy,
    y: u * uy + v * ux,
  });
  return [
    point(left, top),
    point(right, top),
    point(right, bottom),
    point(left, bottom),
  ];
}

function boxScore(
  prob: Float32Array,
  width: number,
  height: number,
  { ux, uy, left, right, top, bottom }: Rectangle,
) {
  const minY = Math.min(left * uy, right * uy) + top * ux;
  const maxY = Math.max(left * uy, right * uy) + bottom * ux;
  const y0 = Math.max(0, Math.ceil(minY - 1e-6));
  const y1 = Math.min(height - 1, Math.floor(maxY + 1e-6));
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    // Intersect the rectangle with this scanline rather than score its entire AABB.
    let lo = Math.max(0, (left - y * uy) / ux);
    let hi = Math.min(width - 1, (right - y * uy) / ux);
    if (uy > 0) {
      lo = Math.max(lo, (y * ux - bottom) / uy);
      hi = Math.min(hi, (y * ux - top) / uy);
    } else if (uy < 0) {
      lo = Math.max(lo, (y * ux - top) / uy);
      hi = Math.min(hi, (y * ux - bottom) / uy);
    }
    const first = Math.ceil(lo - 1e-6);
    const last = Math.floor(hi + 1e-6);
    if (last < first) continue;
    count += last - first + 1;
    const end = y * width + last;
    for (let pixel = y * width + first; pixel <= end; pixel++)
      sum += prob[pixel];
  }
  return count ? sum / count : 0;
}

// PP-OCRv5 mobile det's DB thresholds: bitmap .3, box mean .6, unclip 1.5.
// Eight-connected components supply the outer hull without retaining contours
// (holes don't matter for the quad; their probabilities still affect its score).
export function decodePaddleBoxes(
  prob: Float32Array,
  width: number,
  height: number,
) {
  const mask = new Uint8Array(width * height);
  let any = false;
  for (let i = 0; i < mask.length; i++) {
    if (prob[i] > 0.3) {
      mask[i] = 1;
      any = true;
    }
  }
  const boxes: Quad[] = [];
  if (!any) return boxes;

  const queue = new Int32Array(mask.length);
  const rowLeft = new Int32Array(height);
  const rowRight = new Int32Array(height);
  const rowComponent = new Int32Array(height);
  let component = 0;
  let candidates = 0;
  for (let start = 0; start < mask.length && candidates < 1000; start++) {
    if (!mask[start]) continue;
    component++;
    let read = 0;
    let end = 1;
    let lastY = Math.floor(start / width);
    const firstY = lastY;
    queue[0] = start;
    mask[start] = 0;
    while (read < end) {
      const pos = queue[read++];
      const y = Math.floor(pos / width);
      const x = pos - y * width;
      if (y > lastY) lastY = y;
      if (rowComponent[y] !== component) {
        rowComponent[y] = component;
        rowLeft[y] = rowRight[y] = x;
      } else {
        if (x < rowLeft[y]) rowLeft[y] = x;
        if (x > rowRight[y]) rowRight[y] = x;
      }
      const left = Math.max(0, x - 1);
      const right = Math.min(width - 1, x + 1);
      for (
        let iy = Math.max(0, y - 1);
        iy <= Math.min(height - 1, y + 1);
        iy++
      ) {
        const stop = iy * width + right;
        for (let n = iy * width + left; n <= stop; n++) {
          if (!mask[n]) continue;
          mask[n] = 0;
          queue[end++] = n;
        }
      }
    }
    if (lastY - firstY < 3) continue;
    const points: Point[] = [];
    for (let y = firstY; y <= lastY; y++) {
      points.push({ x: rowLeft[y], y });
      if (rowLeft[y] !== rowRight[y]) points.push({ x: rowRight[y], y });
    }
    const hull = convexHull(points);
    if (hull.length < 3) continue;
    const rect = minimumRectangle(hull)!;
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    if (Math.min(w, h) < 3) continue;
    candidates++;
    if (boxScore(prob, width, height, rect) < 0.6) continue;
    // DB expands by area * ratio / perimeter. The oriented bounding
    // rectangle of the round offset adds this distance on all four sides.
    const expansion = (w * h * 1.5) / (2 * (w + h));
    if (Math.min(w, h) + 2 * expansion < 5) continue;
    rect.left -= expansion;
    rect.top -= expansion;
    rect.right += expansion;
    rect.bottom += expansion;
    boxes.push(quad(rect));
  }
  return boxes;
}
