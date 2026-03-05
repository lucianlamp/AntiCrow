import { onRequestOptions as __api_waitlist_register_ts_onRequestOptions } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\register.ts"
import { onRequestPost as __api_waitlist_register_ts_onRequestPost } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\register.ts"
import { onRequestGet as __api_waitlist_status_ts_onRequestGet } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\status.ts"
import { onRequestOptions as __api_waitlist_status_ts_onRequestOptions } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\status.ts"

export const routes = [
    {
      routePath: "/api/waitlist/register",
      mountPath: "/api/waitlist",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_waitlist_register_ts_onRequestOptions],
    },
  {
      routePath: "/api/waitlist/register",
      mountPath: "/api/waitlist",
      method: "POST",
      middlewares: [],
      modules: [__api_waitlist_register_ts_onRequestPost],
    },
  {
      routePath: "/api/waitlist/status",
      mountPath: "/api/waitlist",
      method: "GET",
      middlewares: [],
      modules: [__api_waitlist_status_ts_onRequestGet],
    },
  {
      routePath: "/api/waitlist/status",
      mountPath: "/api/waitlist",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_waitlist_status_ts_onRequestOptions],
    },
  ]