package main

import (
 "fmt"
 "net"
 "net/http"
 "strings"
 "time"
)

func (a *App) rateLimit(next http.Handler)http.Handler{return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){if !strings.HasPrefix(r.URL.Path,"/v1/"){next.ServeHTTP(w,r);return};host,_,err:=net.SplitHostPort(r.RemoteAddr);if err!=nil{host=r.RemoteAddr};limit:=120;window:=time.Minute;if strings.HasPrefix(r.URL.Path,"/v1/auth/register"){limit=5;window=time.Hour}else if strings.HasPrefix(r.URL.Path,"/v1/auth/login"){limit=10;window=time.Minute};now:=time.Now().UTC();bucket:=now.Unix()/int64(window.Seconds());key:=fmt.Sprintf("aegispay:rate:%s:%d:%d",host,window.Seconds(),bucket);count,err:=a.redis.Incr(r.Context(),key).Result();if err==nil&&count==1{_ = a.redis.Expire(r.Context(),key,window+time.Second).Err()};if err!=nil{writeJSON(w,503,problem{Error:"rate limiting service unavailable",RequestID:requestID(r)});return};if count>int64(limit){w.Header().Set("Retry-After",fmt.Sprint(int64(window.Seconds())-now.Unix()%int64(window.Seconds())));writeJSON(w,429,problem{Error:"rate limit exceeded",RequestID:requestID(r)});return};next.ServeHTTP(w,r)})}
