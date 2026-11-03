package main

import (
 "database/sql"
 "encoding/base64"
 "encoding/json"
 "errors"
 "net/http"
 "strconv"
 "strings"
 "time"
)

type pageCursor struct { ID string `json:"id"`; CreatedAt time.Time `json:"created_at"` }
func pagination(r *http.Request)(int,*pageCursor,error){limit:=25;if raw:=r.URL.Query().Get("limit");raw!=""{n,err:=strconv.Atoi(raw);if err!=nil||n<1||n>100{return 0,nil,errors.New("limit must be between 1 and 100")};limit=n};raw:=r.URL.Query().Get("cursor");if raw==""{return limit,nil,nil};data,err:=base64.RawURLEncoding.DecodeString(raw);if err!=nil{return 0,nil,errors.New("invalid cursor")};var c pageCursor;if json.Unmarshal(data,&c)!=nil||c.ID==""||c.CreatedAt.IsZero(){return 0,nil,errors.New("invalid cursor")};return limit,&c,nil}
func encodeCursor(c pageCursor)string{data,_:=json.Marshal(c);return base64.RawURLEncoding.EncodeToString(data)}
func pageResponse(w http.ResponseWriter,data []map[string]any,more bool,cursor string){var next any;if more{next=cursor};writeJSON(w,200,map[string]any{"data":data,"has_more":more,"next_cursor":next})}
func cursorArgs(c *pageCursor)(any,any){if c==nil{return nil,nil};return c.CreatedAt,c.ID}
func (a *App) listCustomers(w http.ResponseWriter,r *http.Request,org string){limit,c,err:=pagination(r);if err!=nil{bad(w,r,err.Error());return};at,id:=cursorArgs(c);rows,err:=a.db.QueryContext(r.Context(),`SELECT id,name,email,phone,status,created_at FROM customers WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4`,org,at,id,limit+1);if err!=nil{writeJSON(w,500,problem{Error:"database error"});return};defer rows.Close();data:=[]map[string]any{};for rows.Next(){var x pageCursor;var name,status string;var email,phone sql.NullString;if rows.Scan(&x.ID,&name,&email,&phone,&status,&x.CreatedAt)!=nil{continue};data=append(data,map[string]any{"id":x.ID,"name":name,"email":nullableNull(email),"phone":nullableNull(phone),"status":status,"created_at":x.CreatedAt})};more:=len(data)>limit;var next string;if more{data=data[:limit];next=encodeCursor(pageCursor{ID:data[len(data)-1]["id"].(string),CreatedAt:data[len(data)-1]["created_at"].(time.Time)})};pageResponse(w,data,more,next)}
func (a *App) listAccounts(w http.ResponseWriter,r *http.Request,org string){limit,c,err:=pagination(r);if err!=nil{bad(w,r,err.Error());return};at,id:=cursorArgs(c);rows,err:=a.db.QueryContext(r.Context(),`SELECT id,customer_id,currency,account_type,status,created_at FROM accounts WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4`,org,at,id,limit+1);if err!=nil{writeJSON(w,500,problem{Error:"database error"});return};defer rows.Close();data:=[]map[string]any{};for rows.Next(){var x pageCursor;var customer sql.NullString;var currency,typ,status string;if rows.Scan(&x.ID,&customer,&currency,&typ,&status,&x.CreatedAt)!=nil{continue};data=append(data,map[string]any{"id":x.ID,"customer_id":nullableNull(customer),"currency":currency,"account_type":typ,"status":status,"created_at":x.CreatedAt})};more:=len(data)>limit;var next string;if more{data=data[:limit];next=encodeCursor(pageCursor{ID:data[len(data)-1]["id"].(string),CreatedAt:data[len(data)-1]["created_at"].(time.Time)})};pageResponse(w,data,more,next)}
func (a *App) listCollections(w http.ResponseWriter,r *http.Request,org string){limit,c,err:=pagination(r);if err!=nil{bad(w,r,err.Error());return};at,id:=cursorArgs(c);rows,err:=a.db.QueryContext(r.Context(),`SELECT id,status,currency,reference,description,amount_minor,created_at FROM collections WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4`,org,at,id,limit+1);if err!=nil{writeJSON(w,500,problem{Error:"database error"});return};defer rows.Close();data:=[]map[string]any{};for rows.Next(){var x pageCursor;var status,currency,reference,description string;var amount int64;if rows.Scan(&x.ID,&status,&currency,&reference,&description,&amount,&x.CreatedAt)!=nil{continue};data=append(data,map[string]any{"id":x.ID,"status":status,"currency":strings.TrimSpace(currency),"reference":reference,"description":description,"amount":amount,"created_at":x.CreatedAt})};more:=len(data)>limit;var next string;if more{data=data[:limit];next=encodeCursor(pageCursor{ID:data[len(data)-1]["id"].(string),CreatedAt:data[len(data)-1]["created_at"].(time.Time)})};pageResponse(w,data,more,next)}
func (a *App) listTransfers(w http.ResponseWriter, r *http.Request, org string) {
	limit, c, err := pagination(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	at, id := cursorArgs(c)
	rows, err := a.db.QueryContext(r.Context(), `SELECT t.id,t.status,t.currency,t.reference,t.amount_minor,t.created_at,
		(SELECT count(*) FROM transfer_approvals v WHERE v.organization_id=t.organization_id AND v.transfer_id=t.id AND v.decision='approved'),
		COALESCE((SELECT required_approvals FROM transaction_policies p WHERE p.organization_id=t.organization_id AND p.currency=t.currency),1)
		FROM transfers t WHERE t.organization_id=$1 AND ($2::timestamptz IS NULL OR (t.created_at,t.id)<($2,$3))
		ORDER BY t.created_at DESC,t.id DESC LIMIT $4`, org, at, id, limit+1)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer rows.Close()
	data := []map[string]any{}
	for rows.Next() {
		var x pageCursor
		var status, currency, reference string
		var amount int64
		var approvals, required int
		if rows.Scan(&x.ID, &status, &currency, &reference, &amount, &x.CreatedAt, &approvals, &required) != nil {
			continue
		}
		data = append(data, map[string]any{"id": x.ID, "status": status, "currency": currency, "reference": reference, "amount": amount, "created_at": x.CreatedAt, "approvals_received": approvals, "required_approvals": required})
	}
	more := len(data) > limit
	var next string
	if more {
		data = data[:limit]
		next = encodeCursor(pageCursor{ID: data[len(data)-1]["id"].(string), CreatedAt: data[len(data)-1]["created_at"].(time.Time)})
	}
	pageResponse(w, data, more, next)
}
func nullableNull(v sql.NullString)any{if !v.Valid{return nil};return v.String}
