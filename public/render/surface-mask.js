export const RAW_SURFACE_COLORS = Object.freeze({
  fairway: '#ff0000',
  tee: '#ff0000',
  green: '#ffff00',
  bunker: '#0000ff',
});

// Fill every shape in one colour, softened by `blurPx`. A canvas filter blurs a
// whole-canvas layer on every draw, so filling each polygon through blur() costs one
// full-size blur per shape. On a big course (Hazeltine: ~300 shapes on a 3777x4096
// canvas, several canvases per load) that queued enough GPU work for the macOS GPU
// watchdog to drop the canvas, leaving the ground untextured; on a CPU canvas it took
// ~90 s. So the shapes go crisp onto a scratch `layer` (same size as the target),
// and the layer is drawn through the blur once.
// trace(ctx, shape) adds one closed sub-path for the shape.
export function fillShapesBlurred(context, shapes, { fillStyle, blurPx = 0, trace, layer = null }) {
  if (!shapes.length) return;
  const blurred = blurPx > 0;
  if (blurred && !layer) throw new Error('A blurred fill needs a scratch layer canvas');
  const target = blurred ? layer.getContext('2d') : context;
  if (blurred) target.clearRect(0, 0, layer.width, layer.height);
  target.fillStyle = fillStyle;
  for (const shape of shapes) {
    target.beginPath();
    trace(target, shape);
    target.fill();
  }
  if (!blurred) return;
  const filter = context.filter;
  context.filter = `blur(${blurPx}px)`;
  context.drawImage(layer, 0, 0);
  context.filter = filter;
}

export function paintSurfaceMask({
  bounds,
  surfaces,
  kinds,
  colors = null,
  blurPx = 1,
  additive = false,
  canvasFactory = () => document.createElement('canvas'),
}) {
  const extX = bounds.maxX - bounds.minX;
  const extY = bounds.maxY - bounds.minY;
  const ppm = Math.min(2.2, 4096 / Math.max(extX, extY));
  const width = Math.round(extX * ppm);
  const height = Math.round(extY * ppm);
  const canvas = canvasFactory();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Surface-mask canvas has no 2D context');

  let layer = null;
  if (blurPx > 0) {
    layer = canvasFactory();
    layer.width = width;
    layer.height = height;
  }

  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  const px = (x) => (x - bounds.minX) * ppm;
  const py = (y) => (bounds.maxY - y) * ppm;
  const trace = (ctx, poly) => {
    ctx.moveTo(px(poly[0][0]), py(poly[0][1]));
    for (let i = 1; i < poly.length; i += 1) ctx.lineTo(px(poly[i][0]), py(poly[i][1]));
    ctx.closePath();
  };
  context.filter = 'none';
  if (additive) context.globalCompositeOperation = 'lighter';

  try {
    for (const kind of kinds) {
      const shapes = surfaces
        .filter((surface) => surface.kind === kind && surface.poly?.length)
        .map((surface) => surface.poly);
      fillShapesBlurred(context, shapes, {
        fillStyle: colors ? (colors[kind] || colors.default || '#fff') : '#fff',
        blurPx,
        trace,
        layer,
      });
    }
  } finally {
    // The raw RGB mask uses additive channel ownership. Always restore ordinary
    // compositing so a reused canvas/context cannot leak `lighter` into later work.
    context.globalCompositeOperation = 'source-over';
    context.filter = 'none';
  }
  return canvas;
}
