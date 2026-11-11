import json
S=lambda **p: {'type':'object','properties':p,'required':list(p)}
string={'type':'string'};number={'type':'number'};boolean={'type':'boolean'}
ref=lambda n:{'$ref':'#/components/schemas/'+n}
array=lambda s:{'type':'array','items':s}
pdf=S(type={'const':'pdf'},page={'type':'integer','minimum':1});pdf['properties'].update(x=number,y=number,quote=string,rects=array(S(x=number,y=number,width=number,height=number)))
epub=S(type={'const':'epub'},href=string);epub['properties'].update(progression=number,quote=string,unresolved=boolean)
doc=S(id=string,type={'enum':['pdf','epub']},title=string,author=string,size=number,createdAt=string,lastOpenedAt=string,favorite=boolean,percentage=number);doc['properties']['progress']=ref('DocumentLocation')
annotation=S(id=string,documentId=string,kind={'enum':['highlight','underline','note','bookmark']},location=ref('DocumentLocation'),quote=string,note=string,color=string,createdAt=string)
schemas={'DocumentLocation':{'oneOf':[pdf,epub]},'Document':doc,'Annotation':annotation,'SearchResult':S(id=string,excerpt=string,location=ref('DocumentLocation')),'Message':S(id=string,documentId=string,role={'enum':['user','assistant']},content=string,createdAt=string),'Provider':S(id={'enum':['codex','claude']},installed=boolean,authenticated=boolean,status=string),'Settings':{'type':'object','additionalProperties':True},'Error':S(error=string)}
schemas['Message']['properties'].update(context=string,references=array(S(text=string,location=ref('DocumentLocation'))))
paths={}
def add(path,method,response,body=None,code='200',query=False):
 op={'responses':{code:{'description':'Success','content':{'application/json':{'schema':response}}},'default':{'description':'Error','content':{'application/json':{'schema':ref('Error')}}}}}
 params=[]
 for param in ['id','annotation']:
  if '{'+param+'}' in path:params.append({'in':'path','name':param,'required':True,'schema':string})
 if query:params.append({'in':'query','name':'q','required':True,'schema':string})
 if params:op['parameters']=params
 if body:op['requestBody']={'required':True,'content':{'application/json':{'schema':body}}}
 paths.setdefault(path,{})[method]=op
add('/api/documents','get',array(ref('Document')))
add('/api/documents','post',ref('Document'),code='201')
paths['/api/documents']['post']['requestBody']={'required':True,'content':{'multipart/form-data':{'schema':S(file={'type':'string','format':'binary'})}}}
patch=S(favorite=boolean,progress=ref('DocumentLocation'),percentage=number);patch['required']=[]
add('/api/documents/{id}','patch',ref('Document'),patch)
add('/api/documents/{id}/annotations','get',array(ref('Annotation')))
a=dict(annotation);a['required']=['kind','location','quote','note','color'];add('/api/documents/{id}/annotations','post',ref('Annotation'),a,code='201')
add('/api/documents/{id}/annotations/{annotation}','delete',{},code='204')
add('/api/documents/{id}/search','get',array(ref('SearchResult')),query=True)
add('/api/documents/{id}/messages','get',array(ref('Message')))
add('/api/documents/{id}/chat','post',string,S(provider={'enum':['codex','claude']},prompt=string,context=string,references=array(S(text=string,location=ref('DocumentLocation')))))
paths['/api/documents/{id}/chat']['post']['requestBody']['content']['application/json']['schema']['required']=['provider','prompt','context']
paths['/api/documents/{id}/chat']['post']['responses']['200']={'description':'SSE: status, delta {text}, error {error}, done {ok}. Disconnection cancels CLI.','content':{'text/event-stream':{'schema':string}}}
add('/api/providers','get',array(ref('Provider')))
add('/api/settings','get',ref('Settings'));add('/api/settings','put',ref('Settings'),ref('Settings'))
spec={'openapi':'3.1.0','info':{'title':'NeoRead Local API','version':'0.1.0'},'security':[{'session':[]}],'paths':paths,'components':{'securitySchemes':{'session':{'type':'http','scheme':'bearer'}},'schemas':schemas}}
open('docs/openapi.yaml','w').write(json.dumps(spec,ensure_ascii=False,indent=2)+'\n')
