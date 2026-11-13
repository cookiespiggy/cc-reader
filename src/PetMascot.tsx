import { useId } from "react";

/** Claude Code 的像素小宠物, 放在 app 主页空态.
 * 24x20 网格: 身体 / 左右钳 / 4 条腿 / 两只方眼.
 * 眼睛用 mask 镂空而不是写死背景色, 深浅主题都通用. */
export default function PetMascot({ size = 88 }: { size?: number }) {
  const maskId = `pet-eyes-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className="mascot"
      width={size}
      height={(size * 20) / 24}
      viewBox="0 0 24 20"
      role="img"
      aria-label="CC Reader 小助手"
      shapeRendering="crispEdges"
    >
      <defs>
        <mask id={maskId}>
          <rect width="24" height="20" fill="#fff" />
          <rect x="6" y="5" width="2" height="4" fill="#000" />
          <rect x="16" y="5" width="2" height="4" fill="#000" />
        </mask>
      </defs>
      <g fill="currentColor" mask={`url(#${maskId})`}>
        <rect x="3" y="2" width="18" height="13" />
        <rect x="0" y="8" width="3" height="4" />
        <rect x="21" y="8" width="3" height="4" />
        <rect x="4" y="15" width="2" height="4" />
        <rect x="8" y="15" width="2" height="4" />
        <rect x="14" y="15" width="2" height="4" />
        <rect x="18" y="15" width="2" height="4" />
      </g>
    </svg>
  );
}
