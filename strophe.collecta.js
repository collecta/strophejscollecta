// Collecta streaming search plug-in for Strophe
//
// This plug-in manages a set of streaming searches to the Collecta API.
// Each search is a pubsub subscription to Collecta.  Atom payloads will
// be delivered to the user-supplied callback function as new results become
// available.
//
// Plug-in methods:
//   subscribe(query, options)
//     start watching a query
//
//     query - string containing desired search query
//     options - object with possible properties: api_key, query, rate_limit,
//       context_count, and score_threshold. see Collecta api docs for 
//       details on most of these. context_count is the number of historical
//       items to fetch for context. api_key and query are required; others 
//       are optional.
//
//   unsubscribeAll()
//     unsubscribe from all searches

Strophe.addConnectionPlugin('collecta', {
    PUBSUB_SERVICE: 'search.collecta.com',
    PUBSUB_NODE: 'search',

    init: function (connection) {
        this.conn = connection;
        this.searches = {};
        this.handlers = [];

        var base_ns = 'http://api.collecta.com/ns/search-0';

        // add dependent namespaces
        Strophe.addNamespace('PUBSUB', 'http://jabber.org/protocol/pubsub');
        Strophe.addNamespace('PUBSUB_EVENT',
                             Strophe.NS.PUBSUB + '#event');
        Strophe.addNamespace('PUBSUB_SUBSCRIBE_OPTIONS',
                             Strophe.NS.PUBSUB + '#subscribe_options');
        Strophe.addNamespace('DATAFORMS', 'jabber:x:data');
        Strophe.addNamespace('RESULTSET', 'http://jabber.org/protocol/rsm');
        Strophe.addNamespace('ATOM', 'http://www.w3.org/2005/Atom');

        // add collecta namespaces
        Strophe.addNamespace('COLLECTA', base_ns + '#results');
        Strophe.addNamespace('COLLECTA_ERROR', base_ns + '#error');
        Strophe.addNamespace('COLLECTA_IMAGE', 'collecta-abstract-image');
        Strophe.addNamespace('COLLECTA_FIELD_APIKEY', 'x-collecta#apikey');
        Strophe.addNamespace('COLLECTA_FIELD_QUERY', 'x-collecta#query');
        Strophe.addNamespace('COLLECTA_FORM_OPTIONS', 'collecta#options');
    },

    subscribe: function (query, options) {
        var callback = null, errback = null;
        if (options && options.callback) {
            callback = errback = options.callback;
        }
        if (options && options.success) {
            callback = options.success;
        }
        if (options && options.error) {
            errback = options.error;
        }

        var search = {
            query: query,
            api_key: options && options.api_key || null,
            rate_limit: options && options.rate_limit || null,
            score_threshold: options && options.score_threshold || null,
            callback: callback,
            errback: errback};

        this.searches[query] = search;

        var that = this;

        // get latest items
        this.conn.sendIQ(
            $iq({to: this.PUBSUB_SERVICE, type: "get"})
                .c('pubsub', {xmlns: Strophe.NS.PUBSUB})
                .c('items', {node: this.PUBSUB_NODE}).up()
                .c('options', {node: this.PUBSUB_NODE})
                .c('x', {xmlns: Strophe.NS.DATAFORMS, type: 'submit'})
                .c('field', {'var': 'FORM_TYPE', type: 'hidden'})
                .c('value').t(Strophe.NS.COLLECTA_FORM_OPTIONS).up().up()
                .c('field', {'var': Strophe.NS.COLLECTA_FIELD_APIKEY})
                .c('value').t(search.api_key).up().up()
                .c('field', {'var': Strophe.NS.COLLECTA_FIELD_QUERY})
                .c('value').t(search.query).up().up()
                .up().up()
                .c('set', {xmlns: Strophe.NS.RESULTSET})
                .c('max').t('' + (options && options.context_count || 10)),
            function (iq) {
                if (!callback) { return; }

                that._notify(iq, callback, true);
            },
            function (iq) {
                if (errback) {
                    errback(iq, true);
                }
            });


        // do subscription to new results
        var iq = $iq({to: this.PUBSUB_SERVICE, type: 'set'})
            .c('pubsub', {xmlns: Strophe.NS.PUBSUB})
            .c('subscribe', {jid: this.conn.jid,
                             node: this.PUBSUB_NODE}).up()
            .c('options', {node: this.PUBSUB_NODE})
            .c('x', {xmlns: Strophe.NS.DATAFORMS,
                     type: 'submit'})
            .c('field', {'var': 'FORM_TYPE', type: 'hidden'})
            .c('value').t(Strophe.NS.PUBSUB_SUBSCRIBE_OPTIONS).up().up()
            .c('field', {'var': Strophe.NS.COLLECTA_FIELD_APIKEY})
            .c('value').t(search.api_key).up().up()
            .c('field', {'var': Strophe.NS.COLLECTA_FIELD_QUERY})
            .c('value').t(search.query);

        this.conn.sendIQ(
            iq,
            function (iq) {
                if (!callback) { return; }

                // set up callback handler
                var handler = that.conn.addHandler(
                    function (message) {
                        // check if event is for this search
                        var elems = message.getElementsByTagName('header');
                        var i;
                        for (i = 0; i < elems.length; i++) {
                            if (elems[i].getAttribute('name') === Strophe.NS.COLLECTA_FIELD_QUERY) {
                                that._notify(message, callback, false);
                            }
                        }
                        return true;
                    },
                    Strophe.NS.PUBSUB_EVENT, "message");
                that.handlers.push(handler);
            },
            function (iq) {
                if (errback) {
                    errback(iq, false);
                }
            });
    },

    unsubscribeAll: function () {
        // get first search
        var firstKey = null;
        for (var k in this.searches) {
            if (this.searches.hasOwnProperty(k)) {
                firstKey = k;
                break;
            }
        }

        if (firstKey) {
            this.conn.sendIQ(
                $iq({to: this.PUBSUB_SERVICE, type: "set"})
                    .c('pubsub', {xmlns: Strophe.NS.PUBSUB})
                    .c('unsubscribe', {node: this.PUBSUB_NODE,
                                       jid: this.conn.jid}));


            for (var i = 0; i < this.handlers.length; i++) {
                this.conn.deleteHandler(this.handlers[i]);
            }
            this.handlers = [];
            this.searches = {};
        }
    },

    _notify: function (elem, callback, archive_flag) {
        var atom_elems = elem.getElementsByTagName('entry');

        for (var i = 0; i < atom_elems.length; i++) {
            if (atom_elems[i].getAttribute('xmlns') === Strophe.NS.ATOM) {
                callback(atom_elems[i], archive_flag);
            }
        }
    }
});