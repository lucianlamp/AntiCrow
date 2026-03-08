import { onRequestOptions as __functions_api_waitlist_register_ts_onRequestOptions } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\functions\\api\\waitlist\\register.ts"
import { onRequestPost as __functions_api_waitlist_register_ts_onRequestPost } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\functions\\api\\waitlist\\register.ts"
import { onRequestGet as __functions_api_waitlist_status_ts_onRequestGet } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\functions\\api\\waitlist\\status.ts"
import { onRequestOptions as __functions_api_waitlist_status_ts_onRequestOptions } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\functions\\api\\waitlist\\status.ts"
import { onRequestPost as __api_admin_invite_ts_onRequestPost } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\admin\\invite.ts"
import { onRequestPost as __api_admin_notify_update_ts_onRequestPost } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\admin\\notify-update.ts"
import { onRequestGet as __api_admin_releases_ts_onRequestGet } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\admin\\releases.ts"
import { onRequestPost as __api_admin_releases_ts_onRequestPost } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\admin\\releases.ts"
import { onRequestGet as __api_admin_stats_ts_onRequestGet } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\admin\\stats.ts"
import { onRequestGet as __api_admin_users_ts_onRequestGet } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\admin\\users.ts"
import { onRequestOptions as __api_waitlist_register_ts_onRequestOptions } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\register.ts"
import { onRequestPost as __api_waitlist_register_ts_onRequestPost } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\register.ts"
import { onRequestGet as __api_waitlist_status_ts_onRequestGet } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\status.ts"
import { onRequestOptions as __api_waitlist_status_ts_onRequestOptions } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\waitlist\\status.ts"
import { onRequestGet as __api_download__token__ts_onRequestGet } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\download\\[token].ts"
import { onRequest as __api_admin__middleware_ts_onRequest } from "C:\\Users\\ytvar\\dev\\anti-crow\\landing-page\\functions\\api\\admin\\_middleware.ts"

export const routes = [
    {
      routePath: "/functions/api/waitlist/register",
      mountPath: "/functions/api/waitlist",
      method: "OPTIONS",
      middlewares: [],
      modules: [__functions_api_waitlist_register_ts_onRequestOptions],
    },
  {
      routePath: "/functions/api/waitlist/register",
      mountPath: "/functions/api/waitlist",
      method: "POST",
      middlewares: [],
      modules: [__functions_api_waitlist_register_ts_onRequestPost],
    },
  {
      routePath: "/functions/api/waitlist/status",
      mountPath: "/functions/api/waitlist",
      method: "GET",
      middlewares: [],
      modules: [__functions_api_waitlist_status_ts_onRequestGet],
    },
  {
      routePath: "/functions/api/waitlist/status",
      mountPath: "/functions/api/waitlist",
      method: "OPTIONS",
      middlewares: [],
      modules: [__functions_api_waitlist_status_ts_onRequestOptions],
    },
  {
      routePath: "/api/admin/invite",
      mountPath: "/api/admin",
      method: "POST",
      middlewares: [],
      modules: [__api_admin_invite_ts_onRequestPost],
    },
  {
      routePath: "/api/admin/notify-update",
      mountPath: "/api/admin",
      method: "POST",
      middlewares: [],
      modules: [__api_admin_notify_update_ts_onRequestPost],
    },
  {
      routePath: "/api/admin/releases",
      mountPath: "/api/admin",
      method: "GET",
      middlewares: [],
      modules: [__api_admin_releases_ts_onRequestGet],
    },
  {
      routePath: "/api/admin/releases",
      mountPath: "/api/admin",
      method: "POST",
      middlewares: [],
      modules: [__api_admin_releases_ts_onRequestPost],
    },
  {
      routePath: "/api/admin/stats",
      mountPath: "/api/admin",
      method: "GET",
      middlewares: [],
      modules: [__api_admin_stats_ts_onRequestGet],
    },
  {
      routePath: "/api/admin/users",
      mountPath: "/api/admin",
      method: "GET",
      middlewares: [],
      modules: [__api_admin_users_ts_onRequestGet],
    },
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
  {
      routePath: "/api/download/:token",
      mountPath: "/api/download",
      method: "GET",
      middlewares: [],
      modules: [__api_download__token__ts_onRequestGet],
    },
  {
      routePath: "/api/admin",
      mountPath: "/api/admin",
      method: "",
      middlewares: [__api_admin__middleware_ts_onRequest],
      modules: [],
    },
  ]