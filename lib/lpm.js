// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, esnext:true*/
const net = require('net');
const http = require('http');
const https = require('https');
const dns = require('dns');
const url = require('url');
const _ = require('lodash');
const hutil = require('hutil');
const {etask, string, date} = hutil;
const socks = require('@luminati-io/socksv5');
const username = require('./username.js');
const ssl = require('./ssl.js');
const util = require('./util.js');
const qw = string.qw;
const lpm_headers = qw`x-hola-context proxy-authorization x-hola-agent
    x-lpm-src-addr x-lpm-session x-hola-timeline-debug x-lpm-firewall-check
    x-lpm-reserved`;
const loopback_ip = '127.0.0.1';
const zproxy_domain = 'zproxy.luminati.io';
const E = module.exports = {};
const defaults = E.defaults = {
    proxy: zproxy_domain
};
const pool_types = E.pool_types = {
    sequential: 0,
    round_robin: 1,
};
class Lmanger {
    constructor(){
        this.servers = [];
    }
    start(){

    }
    stop(){

    }
}

E.Lmanger = Lmanger;

class Lserver {
    constructor(opt){
        this.opt = opt;
        this.sp = etask('Lserver', [()=>this.wait()]);
        this.lreqs = new Map();
        this.srvs = {};
        this.srv = net.createServer(sock=>this.accept(sock));
        if (opt.reverse_lookup_dns||opt.reverse_lookup_values
            ||opt.reverse_lookup_file)
        {
            this.reverse_dns = new Lreverse_dns(opt);
        }
    }
    accept(sock){
        sock.on('error', err=>console.error(err));
        sock.once('data', this.req_router(sock));
    }
    route_req(sock){
        return buffer=>{
            sock.pause();
            let byte = buffer[0];
            let proto = null;
            if (byte==22)
                proto = 'https';
            else if (byte>32 && byte<127)
                proto = 'http';
            else if (byte==5)
                proto = 'socks';
            else
            {
                // XXX maximk: handle unknown protocol
                return sock.end();
            }
            let srv = this.get_srv(proto);
            sock.unshift(buffer);
            sock.resume();
            srv.accept(sock);
        };
    }
    handle_req(req, res, head){
        return this.handle_lreq(new Lrequest(req, res, head));
    }
    handle_lreq(lreq){
        const _this = this;
        let tsk = etask(function*(){
            let lres;
            this.finally(()=>_this.complete_lreq(this.err, lreq, lres));
            this.spawn(lreq.sp);
            lreq.init(yield _this.get_lreq_sess(lreq));
            lres = yield _this.send_req(lreq);
            yield _this.handle_lres(lreq, lres);
            return lres;
        });
        this.sp.spawn(tsk);
        return tsk;
    }
    get_srv(proto){
        if (this.srvs[proto])
            return this.srvs[proto];
        let srv = null;
        if (proto=='http')
            srv = new Lhttp_server(this._opt, this.handle_req.bind(this));
        else if (proto=='https')
            srv = new Lhttps_server(this._opt, this.handle_req.bind(this));
        else if (proto=='socks')
            srv = new Lsocks_server(this._opt, this.srvs);
        if (srv)
            this.srvs[proto] = srv;
        return srv;
    }
    handler_res(lreq){

    }
    complete_req(lreq){

    }
    listen(){
        let _this = this;
        return etask(function*(){
            yield _this.hosts.fetch();
            yield _this.srv.listen(this.opt.port);
        });
    }
    stop(){
        if (this.sp)
            this.sp.return();
        this.srv.stop();
    }
}

E.Lserver = Lserver;

class Lsession_mgr {
    constructor(opt){
        this.sp = etask('Session_mgr', ()=>this.wait());
        this.hosts = new Lhosts();
        const sess_constr = (opt)=>this.establish_session(opt);
        if (opt.session==true || opt.pool_type==pool_types.sequintial
            || opt.pool_type==pool_types.round_robin&&opt.pool_size<1)
        {
            this.pool = new Lseq_pool(sess_constr);
        }
        else if (opt.pool_type==pool_types.round_robin)
            this.pool = new Lround_robin_pool(sess_constr, opt.pool_size);
        if (opt.sticky_ip)
            this.sticky_sess = new Lsess_map({key: 'src_addr'});
        if (opt.allow_proxy_auth)
            this.auth_sess = new Lsess_map({key: 'h_proxy_authorization'});
        this.general_sess = new Lsess_map();
    }
    establish_session(sess_opt = {}){
        let sp = etask([function(){
            // XXX maximk: implement establish session
        }]);
        this.sp.spawn(sp);
        return sp;
    }
    get_lreq_sess(lreq){
        const _this = this;
        if (lreq.only_bypass)
            return null;
        let sp = etask(function*(){
            if (_this.opt.allow_proxy_auth && lreq.authorization)
                return yield _this.authorization_session(lreq);
            if (lreq.h_session)
            {
                return yield _this.constant_session(lreq, 'h_session',
                    lreq.h_session);
            }
            if (_this.opt.session&&_this.opt.session!==true)
            {
                return yield _this.constant_session(lreq, 'constant',
                    this.opt.session);
            }
            if (!_this.pool)
                return yield _this.constant_session(lreq, 'constant', false);
            if (_this.sticky_sess && _this.sticky_sess.has(lreq))
                return _this.sticky_sess.get(lreq);
            let sess = yield _this.pool.ensure_populated_next(lreq);
            if (sess&&_this.opt.sticky_ip)
                _this.sticky_sess.set(lreq, sess);
            return sess;
        });
        this.sp.spawn(sp);
        return sp;
    }
    authorization_session(lreq){
        let _this = this;
        if (this.auth_sess && this.auth_sess.get(lreq))
        {
            let auth_sess = this.auth_sess.get(lreq);
            if (lreq.h_session && lreq.h_session == auth_sess.session)
                return auth_sess;
        }
        let sp = etask(function*(){
            let sess_opt = _.extend({}, lreq.authorization);
            if (sess_opt.timeout)
                sess_opt.request_timeout = sess_opt.timeout;
            if (lreq.h_session)
                sess_opt.session = lreq.h_session;
            let sess = yield this.establish_session(sess_opt);
            this.auth_sess.set(lreq, sess);
            return sess;
        });
        this.sp.spawn(sp);
        return sp;
    }
    constant_session(lreq, name, val){
        let _this = this;
        let sess;
        if (this.general_sess.has(name))
        {
            sess = this.general_sess.get(name);
            if (val === false && !sess.hasOwnPropery('session'))
                return sess;
            if (sess.session == val)
                return sess;
        }
        let sp = etask(function*(){
            let sess_opt = {session: val};
            sess = yield _this.establish_session(sess_opt);
            _this.general_sess.set(name, sess);
            return sess;
        });
        this.sp.spawn(sp);
        return sp;
    }
}

E.Lsession_mgr = Lsession_mgr;

class Lsess_map {
    constructor(opt={}){
        this.opt = _.defaults(opt, {key: false, validate: true});
        this.sessions = Map();
    }
    resolve_key(lreq){
        if (this.opt.key)
            return lreq[this.opt.key];
        return lreq;
    }
    is_valid(sess){
        if (!this.opt.validate)
            return true;
        return !sess || !this.is_expired();
    }
    get(lreq){
        let key = this.resolve_key(lreq);
        let sess = this.sessions.get();
        if (!this.is_valid(sess))
        {
            this.sessions.delete(key);
            sess = null;
        }
        return sess;
    }
    set(lreq, sess){
        if (!this.is_valid(sess))
            return false;
        this.sessions.set(this.resolve_key(lreq), sess);
        return true;
    }
}

E.sess_map = Lsess_map;

class Lreverse_dns {
    constructor(opt = {}){
        this.opt = opt;
        this.sp = etask('Lreverse_dns', [()=>this.wait()]);
        if (opt.reverse_lookup_dns)
            this.dns = true;
        else if (opt.reverse_lookup_values)
            this.domains = this.parse_vals(opt.reverse_lookup_values);
        else if (opt.reverse_lookup_file)
            this.domains = this.read_vals_file(opt.reverse_lookup_file);
    }
    parse_vals(vals){
        const domains = {};
        const ns_re = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([^\s#]+)([\s]*#.*)?$/;
        for (let line of vals)
        {
            const m = line.match(ns_re);
            if (m&&m.length>=2)
                domains[m[1]] = m[2];
        }
        return domains;
    }
    read_vals_file(file){
        return this.parse_vals(hutil.file.read_lines_e(file));
    }
    lookup(ip){
        if (!util.is_ip(ip))
            return ip;
        if (this.domains)
            return this.domains[ip]||ip;
        if (!this.dns)
            return ip;
        let sp = etask(function*(){
            let domains = yield etask.nfn_apply(dns, '.reverse', [ip]);
            if (!domains || !domains.length)
                 return ip;
            return domains[0];
        });
        this.sp.spawn(sp);
        return sp;
    }
    lookup_url(_url){
        const _this = this;
        let purl = url.parse(_url);
        let sp = etask(function*(){
            purl.hostname = yield _this.lookup(purl.hostname);
            return url.format(purl);
        });
        this.sp.spawn(sp);
        return sp;
    }
}

E.Lreverse_dns = Lreverse_dns;

class Lhosts {
    constructor(opt){
        this.opt = opt;
        this.sp = etask('Lhosts', [()=>this.wait()]);
        this.hosts = [];
        this.host_sess = Map();
        this.proxy_count = opt.proxy_count;
        this.proxy_cache = opt._proxy_cache;
        this.conf_prxies = [].concat(opt.proxy||defaults.proxy);
        this.fetch_timeout = (opt.proxy_fetch_timeout||30)*date.ms.SEC;
        this.first_fetch = true;
        this.fetching = false;
    }
    fetch(){
        const _this = this;
        let sp = etask(function*(){
            let hosts, proxies = this.conf_prxies.slice(0), timeout = false;
            const tm = setTimeout(()=>{ timeout = true; }, this.fetch_timeout);
            this.finally(()=>_this.fetch_complete(this.error));
            let cached_hosts = _this.hosts;
            if (_this.first_fetch&&_this.proxy_cache)
            {
                cached_hosts = yield _this.proxy_cache.get(proxies)||[];
                _this.first_fetch = false;
            }
            hosts = cached_hosts.reduce((acc, h)=>acc.set(h, false),
                new Map());
            _this.fetching = true;
            while (proxies.length&&hosts.length<_this.proxy_count&&!timeout)
            {
                let proxy = proxies.shift();
                if (util.is_ip(proxy))
                {
                    hosts.set(proxy, false);
                    continue;
                }
                proxies.push(proxy);
                let domain = proxy.length==2 ? zproxy_domain : proxy;
                try {
                    let ips = yield _this.fetch_from_dns(domain);
                    ips.forEach(ip=>hosts[ip] = proxy);
                } catch(e){
                    // XXX maximk: handle detach host from dns error
                }
            }
            clearTimeout(tm);
            _this.hosts = _.shuffle(Object.keys(hosts));
            if (_this.opt._proxy_cache)
                yield this.proxy_cache(_.toPairs(hosts).filter(p=>p[1]));
        });
        this.sp.spawn(sp);
        return sp;
    }
    fetch_complete(err){
        if (err||!this.hosts.length)
        {
            // XXX maximk: handle failed to resolve proxies
        }
        this.fetching = false;
    }
    fetch_from_dns(domain){
        if (domain==zproxy_domain)
            domain = `${this.calc_zproxy_uname()}.${domain}`;
        return etask.nfn_apply(dns, '.resolve', [domain]);
    }
    calc_zproxy_uname(){
        return `customer-${this.opt.customer}-session-${Date.now()}`;
    }
    has_next(){ return !!this.hosts.length; }
    next(){
        let hst = null;
        if (!this.has_next())
            return hst;
        hst = this.hosts.shift();
        this.hosts.push(hst);
        return hst;
    }
}

E.Lhosts = Lhosts;

class Lrequest {
    constructor(req, res, head, opt){
        this.id = util.gen_id();
        this.req = req;
        this.res = res;
        this.head = head;
        this.opt = opt;
        this.sp = etask('Lrequest', [()=>this.wait()]);
        this.sess = null;
        this.is_ssl = util.req_is_ssl(this.req);
    }
    init(){
        const _this = this;
        this.init_headers();
        if (this.opt.allow_proxy_auth)
            this.init_authorization();
        let sp = etask(function*(){
            // XXX maximk: implement
            return yield true;
        });
        this.sp.spawn(sp);
        return sp;
    }
    init_headers(){
        this.headers = Object.asssign({}, this.req.headers);
        this.raw_headers = Object.assing({}, this.req.rawHeaders);
        lpm_headers.forEach(h=>{
            let v_name = 'h_'+h.replace(/^(x-hola-|x-lpm-)/, '')
            .replace('-', '_');
            this[v_name] = this.headers[h]||null;
            delete this.headers[h];
        });
    }
    init_authorization(){
        if (!this.h_proxy_authorization)
            return;
        this.authorization = username.parse(this.h_proxy_authorization);
    }
    set_sess(sess){
        this.sess = sess;
    }
    destroy(){
        this.sp.return();
    }
}

E.Lrequest = Lrequest;

class Lsession {
    constructor(opt){
        this.created = Date.now();
        this.opt = opt;
        this.duration = util.param_rand_range(opt.session_duration, 1000);
        this.max_requests = util.param_rand_range(opt.max_requests);
        this.count = 0;
    }
    calculate_username(){ return username.calc(this.opt); }
    is_expired(){
        return this.max_requests&&this.count>=this.max_requests
            ||this.duration && Date.now()-this.created>this.duration;
    }
}

E.Lsession = Lsession;

class Lround_robin_pool {
    constructor(itm_constr, size){
        this.sp = etask('Round_robin_pool', [()=>this.wait()]);
        this.itm_constr = itm_constr;
        this.itms = [];
        this.size = size;
        this.populate_sp = null;
        this.ready = false;
    }
    populate(){
        let _this = this;
        if (this.populate_sp)
            return this.populate_sp;
        let sp = etask(function*(){
            _this.populate_sp = this;
            let sess_sp = [];
            this.finally(()=>{
                // XXX maximk: handle populate errors
                if (!_this.ready && _this.itms.length>0)
                    _this.ready = true;
                _this.populate_sp = null;
            });
            _this.ready = false;
            for (let i=_this.itms.length; i<_this.size; i++)
                sess_sp.push(_this.itm_constr());
            (yield etask.all(sess_sp)).forEach(s=>_this.itms.push(s));
            _this.ready = true;
        });
        this.sp.spawn(sp);
        return sp;
    }
    has_next(){
        return !!this.itms.length;
    }
    clean_expired(){
        return _.remove(this.itms, itm=>itm.is_expired());
    }
    next(){
        let itm = null;
        if (!this.has_next())
            return itm;
        itm = this.itms.shift();
        this.itms.push(itm);
        return itm;
    }
    ensure_populated_next(){
        const _this = this;
        let sp = etask(function*(){
            _this.clean_expired();
            if (!_this.has_next())
                yield _this.populate();
            else
                _this.populate();
            return _this.next();
        });
        this.sp.spawn(sp);
        return sp;
    }
    destroy(){
        this.sp.return();
        this.sp = null;
        this.itms = null;
        this.ready = false;
    }
}

E.Lround_robin_pool = Lround_robin_pool;

class Lseq_pool extends Lround_robin_pool {
    constructor(itm_constr){
        super(itm_constr, 1);
        if (this.sp)
            this.sp.return();
        this.sp = etask('Sequintial_pool', [()=>this.wait()]);
    }
}

E.Lseq_pool = Lseq_pool;

class Lrules {

}

E.Lrules = Lrules;

class Ltimeline {

}

E.Ltimeline = Ltimeline;

class Lsocks_server {
    constructor(opt, servers){
        this.opt = opt;
        this.srvs = servers;
        this.srv = null;
    }
    init(){
        this.srv = socks.createServer(this.handle_conn());
        this.srv.useAuth(socks.auth.None());
    }
    handle_conn(){
        return (info, accept, deny)=>{
            if (info.dstPort==80 && this.srvs.http)
                return this.srvs.http.accept_connection(accept(true));
            if (info.dstPort==443 && this.srvs.https)
                return this.srvs.https.accept_connection(accept(true));
            accept();
        };
    }
    accept(sock){
        if (!this.srv)
            this.init();
        this.srv._onConnection(sock);
    }
}

E.Lsocks_server = Lsocks_server;

class Lhttps_server {
    constructor(opt, on_req){
        this.opt = opt;
        this.on_req = on_req;
        this.ssl = opt.ssl;
        this.srv = null;
    }
    init(){
        const conf = this.ssl ? Object.assign({requestCert: false}, ssl())
            : {};
        this.srv = https.createServer(conf);
        this.srv.on('connection', this.handle_conn());
        this.srv.on('request', this.handle_req());
    }
    handle_conn(){ return sock=>sock.setNoDelay(); }
    handle_req(){ return (req, res, head)=>this.on_req(req, res, head); }
    accept(sock){
        if (!this.srv)
            this.init();
        this.srv.emit('connection', sock);
    }
}

E.Lhttps_server = Lhttps_server;

class Lhttp_server {
    constructor(opt, on_req){
        this.opt = opt;
        this.on_req = on_req;
        this.srv = null;
    }
    init(){
        this.srv = http.createServer();
        this.srv.on('connection', this.handle_conn());
        this.srv.on('request', this.handle_req());
    }
    handle_conn(){ return sock=>sock.setNoDelay(); }
    handle_req(){ return (req, res, head)=>this.on_req(req, res, head); }
    accept(sock){
        if (!this.srv)
            this.init();
        this.srv.emit('connection', sock);
    }
}

E.Lhttp_server = Lhttp_server;
