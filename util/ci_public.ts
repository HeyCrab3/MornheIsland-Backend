/**
 * CI 公开端点工具。
 * 按 ObjectId 或 identity 查找班级（优先 ObjectId）。
 */
import { ObjectId } from "mongodb";

export async function findClass(db: any, classIdentity: string) {
  // 优先按 ObjectId 查找
  if (ObjectId.isValid(classIdentity)) {
    const cls = await db.collection("ci_classes").findOne({ _id: new ObjectId(classIdentity) });
    if (cls) return cls;
  }
  // 回退到 identity 字符串
  return db.collection("ci_classes").findOne({ identity: classIdentity });
}
