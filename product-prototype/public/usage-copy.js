export function pointCapacity(value) {
  const points=Math.max(0,Math.floor(Number(value)||0));
  if(!points)return '暂无可用点数';
  if(points<4)return `可复核 ${points} 次，更新还差 ${4-points} 点`;
  return `可更新 ${Math.floor(points/4)} 次，或复核 ${points} 次`;
}
