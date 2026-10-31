import { ImagePlus, Loader2, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ImageAttachment } from "../../../shared/protocol";

type Point = { x: number; y: number };
type Stroke = { points: Point[]; width: number };

// Points use image-relative coordinates, so resizing the pane preserves each mark's position.
function paint(context: CanvasRenderingContext2D, strokes: Stroke[], width: number, height: number) {
  context.strokeStyle = context.fillStyle = "#ed684c";
  context.lineCap = context.lineJoin = "round";
  for (const stroke of strokes) {
    const first = stroke.points[0];
    if (!first) continue;
    context.lineWidth = stroke.width * width;
    context.beginPath();
    if (stroke.points.length === 1) {
      context.arc(first.x * width, first.y * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x * width, first.y * height);
      for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
      context.stroke();
    }
  }
}

export function BrowserAnnotation({ image, title, onCancel, onAttach }: {
  image: string;
  title: string;
  onCancel: () => void;
  onAttach: (image: ImageAttachment) => void;
}) {
  const picture = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, size.width, size.height);
    paint(context, strokes, size.width, size.height);
  }, [strokes, size]);

  const undo = () => setStrokes((all) => all.slice(0, -1));
  const attach = async () => {
    if (!picture.current || !size.width || !strokes.length || exporting) return;
    setExporting(true);
    setError("");
    try {
      const output = document.createElement("canvas");
      output.width = size.width;
      output.height = size.height;
      const context = output.getContext("2d");
      if (!context) throw new Error("Could not create the annotated image.");
      context.drawImage(picture.current, 0, 0);
      paint(context, strokes, size.width, size.height);
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error("Could not save the drawing.")), "image/png"));
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("Could not attach the drawing."));
        reader.readAsDataURL(blob);
      });
      onAttach({ kind: "image", name: "Browser annotation.png", mediaType: "image/png", data });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setExporting(false); }
  };

  const point = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const bounds = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)) };
  };

  return (
    <div className="browser-annotation">
      {strokes.length > 0 && <div className="browser-annotation-actions" role="toolbar" aria-label="Drawing actions">
        <button className="browser-icon" title="Undo stroke (⌘Z)" aria-label="Undo stroke" disabled={!strokes.length || exporting} onClick={undo}><Undo2 size={15} /></button>
        <button className="browser-icon" title="Discard drawing (Esc)" aria-label="Discard drawing" disabled={exporting} onClick={onCancel}><X size={15} /></button>
        <span className="browser-annotation-divider" />
        <button className="browser-attach" disabled={!strokes.length || exporting} onClick={attach}>{exporting ? <Loader2 size={14} className="browser-spin" /> : <ImagePlus size={14} />}Add to chat</button>
      </div>}
      {error && <div className="browser-annotation-error" role="alert">{error}</div>}
      <div className="browser-annotation-scroll"><div className="browser-snapshot browser-drawing">
        <img ref={picture} src={`data:image/png;base64,${image}`} alt={`Browser snapshot of ${title}`} draggable={false}
          onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />
        <canvas ref={canvas} width={size.width} height={size.height} aria-label="Draw on the browser screenshot" tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !exporting) { e.preventDefault(); e.stopPropagation(); onCancel(); }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !exporting) { e.preventDefault(); e.stopPropagation(); undo(); }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || exporting || !size.width || pointer.current !== null) return;
            e.preventDefault();
            e.currentTarget.focus({ preventScroll: true });
            e.currentTarget.setPointerCapture(e.pointerId);
            pointer.current = e.pointerId;
            const width = 3 / e.currentTarget.getBoundingClientRect().width;
            const start = point(e);
            setStrokes((all) => [...all, { points: [start], width }]);
          }}
          onPointerMove={(e) => {
            if (pointer.current !== e.pointerId) return;
            const next = point(e);
            setStrokes((all) => all.map((stroke, index) => index === all.length - 1 ? { ...stroke, points: [...stroke.points, next] } : stroke));
          }}
          onPointerUp={(e) => { if (pointer.current === e.pointerId) pointer.current = null; }}
          onPointerCancel={() => { pointer.current = null; }}
          onLostPointerCapture={() => { pointer.current = null; }}
        />
      </div></div>
    </div>
  );
}
