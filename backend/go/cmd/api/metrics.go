package main

import (
 "fmt"
 "net/http"
 "sort"
 "strings"
 "sync"
 "sync/atomic"
)

type metricKey struct{method,route,status string}
var requestMetrics sync.Map
func routeLabel(path string)string{if !strings.HasPrefix(path,"/v1/"){if strings.HasPrefix(path,"/health/"){return path};return "/other"};parts:=strings.Split(strings.Trim(strings.TrimPrefix(path,"/v1/"),"/"),"/");if len(parts)==0||parts[0]==""{return "/v1"};return "/v1/"+parts[0]}
type metricResponseWriter struct{http.ResponseWriter;status int}
func (w *metricResponseWriter)WriteHeader(status int){if w.status==0{w.status=status};w.ResponseWriter.WriteHeader(status)}
func (w *metricResponseWriter)Write(b []byte)(int,error){if w.status==0{w.status=http.StatusOK};return w.ResponseWriter.Write(b)}
func metrics(next http.Handler)http.Handler{return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){rec:=&metricResponseWriter{ResponseWriter:w};next.ServeHTTP(rec,r);status:=rec.status;if status==0{status=200};key:=metricKey{method:r.Method,route:routeLabel(r.URL.Path),status:fmt.Sprint(status)};value,_:=requestMetrics.LoadOrStore(key,&atomic.Uint64{});value.(*atomic.Uint64).Add(1)})}
func metricsHandler(w http.ResponseWriter,r *http.Request){w.Header().Set("Content-Type","text/plain; version=0.0.4; charset=utf-8");type item struct{k metricKey;v uint64};items:=[]item{};requestMetrics.Range(func(k,v any)bool{items=append(items,item{k.(metricKey),v.(*atomic.Uint64).Load()});return true});sort.Slice(items,func(i,j int)bool{a,b:=items[i].k,items[j].k;if a.route!=b.route{return a.route<b.route};if a.method!=b.method{return a.method<b.method};return a.status<b.status});_,_=fmt.Fprintln(w,"# HELP aegispay_http_requests_total HTTP requests received by route group.");_,_=fmt.Fprintln(w,"# TYPE aegispay_http_requests_total counter");for _,it:=range items{_,_=fmt.Fprintf(w,"aegispay_http_requests_total{method=%q,route=%q,status=%q} %d\n",it.k.method,it.k.route,it.k.status,it.v)}}
