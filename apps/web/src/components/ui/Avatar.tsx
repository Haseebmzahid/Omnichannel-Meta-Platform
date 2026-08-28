import { cn, initials } from '../../lib/utils';

interface AvatarProps {
  name: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES = {
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-[13px]',
  lg: 'size-11 text-sm',
};

// Deterministic hue from the name, not random — the same contact always
// gets the same color, which is a small but real scanning aid in a dense
// list (patients start to have a recognizable "color" the way avatars in
// Linear/GitHub work), without fetching or storing an actual image.
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

export function Avatar({ name, className, size = 'md' }: AvatarProps) {
  const hue = hueFor(name);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', SIZE_CLASSES[size], className)}
      style={{ backgroundColor: `hsl(${hue} 38% 42%)` }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
