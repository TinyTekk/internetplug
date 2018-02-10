// LICENSE_CODE ZON ISC
'use strict'; /*jslint react:true, es6:true*/
import React from 'react';
import $ from 'jquery';
import {Row, Col} from 'react-bootstrap';
import {Input, Select, If, Loader, Modal, Warnings, onboarding,
    emitter, Nav} from './common.js';
import classnames from 'classnames';
import etask from 'hutil/util/etask';
import util from './util.js';
import zurl from 'hutil/util/url';
import Pure_component from '../../www/util/pub/pure_component.js';

const ga_event = util.ga_event;

class Proxy_tester extends Pure_component {
    constructor(props){
        super(props);
        this.state = {response: {}};
        this.title = 'Proxy Tester';
        this.subtitle = 'Emulate requests from your proxies to any target URL';
    }
    update_response(response){ this.setState({response}); }
    render(){
        const body = this.state.response&&this.state.response.body;
        const headers = this.state.response&&this.state.response.headers;
        return (
            <div className="lpm proxy_tester">
              <Nav title={this.title} subtitle={this.subtitle}/>
              <Request update_response={this.update_response.bind(this)}/>
              <Body body={body}/>
              <If when={this.state.response.status_code}>
                <Row>
                  <Col md={4}><Info {...this.state.response}/></Col>
                  <Col md={8}>
                    <Response headers={headers}/></Col>
                </Row>
              </If>
            </div>
        );
    }
}

class Request extends Pure_component {
    constructor(props){
        super(props);
        this.default_state = {headers: [], max_idx: 0, params: {
            url: 'http://lumtest.com/myip.json', method: 'GET'}};
        this.state = {...this.default_state, show_loader: false};
    }
    componentDidMount(){
        setTimeout(()=>{
            const url_o = zurl.parse(document.location.href);
            const qs_o = zurl.qs_parse((url_o.search||'').substr(1));
            const url = qs_o.url||this.state.params.url;
            const method = qs_o.method||this.state.params.method;
            const port = qs_o.port||this.state.params.port;
            this.setdb_on('head.proxies_running', proxies=>{
                if (!proxies||!proxies.length)
                    return;
                this.setState({proxies});
                this.setState(prev_state=>{
                    const def_port = proxies[0].port;
                    this.default_state.params.proxy = def_port;
                    return {params: {...prev_state.params,
                        proxy: port||def_port, method, url}};
                });
            });
        });
    }
    add_header(){
        ga_event('proxy-tester-tab', 'add header');
        this.setState(prev_state=>({
            headers: [...prev_state.headers, {idx: prev_state.max_idx,
                header: '', value: ''}],
            max_idx: prev_state.max_idx+1,
        }));
    }
    remove_header(idx){
        ga_event('proxy-tester-tab', 'remove header');
        this.setState(prev_state=>
            ({headers: prev_state.headers.filter(h=>h.idx!=idx)}));
    }
    update_header(idx, field, value){
        this.setState(prev_state=>({
            headers: prev_state.headers.map(h=>{
                if (h.idx!=idx)
                    return h;
                else
                    return {...h, [field]: value};
            }),
        }));
    }
    update_params(field, value){
        this.setState(prev_state=>({
            params: {...prev_state.params, [field]: value}}));
    }
    reset(){
        ga_event('proxy-tester-tab', 'reset clicked');
        this.setState({...this.default_state});
        this.props.update_response({});
    }
    go(){
        ga_event('proxy-tester-tab', 'run test');
        if (!this.state.params.proxy)
        {
            ga_event('proxy-tester-tab', 'no proxy chosen');
            this.setState({warnings:
                [{msg: 'You need to choose a proxy first'}]});
            $('#warnings_modal').modal();
            return;
        }
        const check_url = '/api/test/'+this.state.params.proxy;
        const body = {
            headers: this.state.headers.reduce((acc, el)=>{
                if (!el.header)
                    return acc;
                else
                    return {...acc, [el.header]: el.value};
            }, {}),
            method: this.state.params.method,
            url: this.state.params.url,
        };
        this.setState({show_loader: true});
        const _this = this;
        this.etask(etask(function*(){
            this.on('uncaught', e=>{
                console.error(e);
                _this.setState({show_loader: false});
                ga_event('proxy-tester-tab', 'unexpected error', e.message);
            });
            const raw_check = yield window.fetch(check_url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body),
            });
            const json_check = yield raw_check.json();
            onboarding.check_tested_proxy();
            const seen_examples = yield onboarding.has_seen_examples();
            if (!seen_examples)
            {
                emitter.emit('setup_guide:progress_modal',
                    'Looks good? now lets browse the web', 2000);
            }
            _this.setState({show_loader: false});
            _this.props.update_response(json_check.response);
            if (json_check.error)
            {
                _this.setState({warnings: [{msg: json_check.error}]});
                $('#warnings_modal').modal();
                ga_event('proxy-tester-tab', 'response has errors',
                    json_check.error);
            }
            else
                ga_event('proxy-tester-tab', 'response successful');
        }));
    }
    render() {
        return (
            <div className="panel request">
              <Loader show={this.state.show_loader}/>
              <Modal className="warnings_modal" id="warnings_modal"
                title="Warnings:" no_cancel_btn>
                <Warnings warnings={this.state.warnings}/>
              </Modal>
              <div className="panel_body">
                <Request_params params={this.state.params}
                  update={this.update_params.bind(this)}
                  proxies={this.state.proxies}/>
                <Headers headers={this.state.headers}
                  clicked_remove={this.remove_header.bind(this)}
                  update={this.update_header.bind(this)}/>
                <Add_header_btn
                  clicked_add={this.add_header.bind(this)}/>
                <Footer_buttons reset_clicked={this.reset.bind(this)}
                  go_clicked={this.go.bind(this)}/>
              </div>
            </div>
        );
    }
}

const Request_params = ({params, update, proxies})=>{
    proxies = (proxies||[]).map(p=>({key: p.port, value: p.port}));
    const methods = [{key: 'GET', value: 'GET'}, {key: 'POST', value: 'POST'}];
    return (
        <div className="request_params">
          <Field params={params} update={update} name="proxy" type="select"
            data={proxies}/>
          <Field params={params} update={update} name="url" type="text"/>
          <Field params={params} update={update} name="method" type="select"
            data={methods}/>
        </div>
    );
};

const Field = ({type, update, name, params, ...props})=>{
    const fields = {proxy: 'Proxy', url: 'URL', method: 'Method'};
    const on_change_wrapper = val=>{
        if (name!='url')
            ga_event('proxy-tester-tab', 'edit '+name);
        update(name, val);
    };
    const on_blur = ()=>{
        if (name=='url')
            ga_event('proxy-tester-tab', 'edit url');
    };
    let Comp;
    if (type=='select')
        Comp = Select;
    else
        Comp = Input;
    const title = fields[name];
    return (
        <div className={classnames('field', name)}>
          <If when={title}>
            <div className="title">{fields[name]}</div>
          </If>
          <Comp on_change_wrapper={on_change_wrapper} type={type}
            val={params[name]} {...props} on_blur={on_blur}/>
        </div>
    );
};

const Add_header_btn = ({clicked_add})=>(
    <div className="add_header_wrapper">
      <button onClick={clicked_add}
        className="btn btn_lpm btn_lpm_normal btn_add_header">
        Add header
      </button>
    </div>
);

const Headers = ({headers, clicked_remove, update})=>(
    <div className="headers">
      {headers.map(h=>
        <New_header_params clicked_remove={clicked_remove} header={h}
          key={h.idx} update={update}/>
      )}
    </div>
);

const New_header_params = ({clicked_remove, update, header})=>{
    const input_changed = field=>value=>{
        update(header.idx, field, value); };
    return (
        <div className="header_line">
          <Input val={header.header}
            on_change_wrapper={input_changed('header')}
            type="text" placeholder="Header" className="header_input"/>
          <Input val={header.value}
            on_change_wrapper={input_changed('value')}
            type="text" placeholder="Value" className="value_input"/>
          <button onClick={()=>clicked_remove(header.idx)}
            className="btn btn_lpm btn_lpm_error">Remove</button>
        </div>
    );
};

const Footer_buttons = ({reset_clicked, go_clicked})=>(
    <div className="footer_buttons">
      <button onClick={go_clicked} className="btn btn_lpm btn_go">Go</button>
      <button onClick={reset_clicked}
        className="btn btn_lpm btn_lpm_error btn_reset">Reset</button>
    </div>
);

const Body = ({body})=>{
    if (!body)
        return null;
    return (
        <div className="panel body">
          <div className="panel_heading">
            <h2>Body</h2>
          </div>
          <div className="panel_body">
            <div className="panel code">
              <div className="panel_body">
                <span>{body}</span>
              </div>
            </div>
          </div>
        </div>
    );
};

const Title_value_pairs = props=>(
    <div className="title_value_pairs">
      {props.pairs.map((p, idx)=>(
        <Pair key={idx} title={p.title} value={p.value}/>))}
    </div>
);

const Pair = props=>(
    <div className="pair">
      <div className="key">{props.title}</div>
      <div className="value">{props.value}</div>
    </div>
);

const Info = ({status_code, status_message, version})=>{
    const pairs = Object.entries({status_code, status_message, version})
    .map(e=>({title: e[0], value: e[1]}));
    return (
        <div className="panel info">
          <div className="panel_heading">
            <h2>Info</h2>
          </div>
          <div className="panel_body">
            <Title_value_pairs pairs={pairs}/>
          </div>
        </div>
    );
};

const Response = ({headers = {}})=>{
    const pairs = Object.entries(headers)
    .map(e=>({title: e[0], value: e[1]}));
    return (
        <div className="panel response">
          <div className="panel_heading">
            <h2>Response headers</h2>
          </div>
          <div className="panel_body">
            <Title_value_pairs pairs={pairs}/>
          </div>
        </div>
    );
};

export default Proxy_tester;
