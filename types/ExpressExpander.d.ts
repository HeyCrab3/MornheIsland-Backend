import type { Db } from 'mongodb'
import type { JwtPayload } from 'jsonwebtoken'

declare module 'express-serve-static-core' {
  interface Request {
    db: Db,
    auth: JwtPayload
  }
}
