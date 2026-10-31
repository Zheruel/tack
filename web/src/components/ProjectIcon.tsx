import { useEffect, useState } from "react";
import type { Project } from "../../../shared/protocol";
import { loadIcon, useApp } from "../store";

// The project's favicon, or a colored monogram tile while it has none.
export function ProjectIcon({ project, className = "size-4" }: { project?: Project; className?: string }) {
  const icon = useApp((s) => (project ? s.icons[project.id] : undefined));
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (project) void loadIcon(project.id);
  }, [project?.id]);
  useEffect(() => setBroken(false), [icon]);
  if (!project) return <span className={`shrink-0 rounded-[5px] border border-dashed border-faint/60 ${className}`} />;
  if (icon && !broken)
    return <img src={icon} alt="" draggable={false} onError={() => setBroken(true)} className={`shrink-0 rounded-[25%] object-contain ${className}`} />;
  return <Monogram name={project.name} className={className} />;
}

// Same name, same color: hashed onto a hue, kept dark and muted to sit quietly in the rail.
function Monogram({ name, className }: { name: string; className: string }) {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const text = (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `hsl(${hue} 28% 24%)`, color: `hsl(${hue} 60% 78%)` }}
      className={`flex shrink-0 items-center justify-center rounded-[5px] text-[7.5px] leading-none font-bold tracking-tight select-none ${className}`}
    >
      {text}
    </span>
  );
}
