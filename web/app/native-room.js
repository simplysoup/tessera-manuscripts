// The detached base tracks only accepted revisions. The live body also
// contains edits waiting to be sent. Native patch transforms keep both in sync.
export const roomScheme = String.raw`
(begin
  (define tessera-url #f)
  (define tessera-author #f)
  (define tessera-base #f)
  (define tessera-pending '())
  (define tessera-listening #f)
  (define tessera-observer #f)

  (define (tessera-change event target modification)
    (when (and tessera-listening (eq? event 'announce)
               (not (eq? (modification-type modification) 'set-cursor)))
      (let ((change (modification-copy modification)))
        (set! tessera-pending
          (cons (patch-pair change (modification-invert change target))
                tessera-pending)))))

  (define (tessera-body)
    (buffer-get-body tessera-url))

  (define (tessera-start url)
    (set! tessera-url url)
    (set! tessera-author (new-author))
    (set! tessera-base (tree-copy (tessera-body)))
    (set! tessera-pending '())
    (set! tessera-observer (tree-observe (tessera-body) "tessera-change"))
    (set! tessera-listening #t))

  (define (tessera-stop)
    (set! tessera-listening #f)
    (when tessera-observer (tree-pointer-detach tessera-observer))
    (set! tessera-observer #f))

  (define (tessera-read source)
    (scheme->patch (string->object source)))

  (define (tessera-take)
    (let ((patch (patch-compound (reverse tessera-pending))))
      (set! tessera-pending '())
      (and (patch-modifies? patch) (object->string (patch->scheme patch)))))

  (define (tessera-accept source)
    (set! tessera-base (patch-apply tessera-base (tessera-read source))))

  (define (tessera-restore source)
    (set! tessera-pending (append tessera-pending (list (tessera-read source)))))

  (define (tessera-apply-remote patch)
    (with-buffer tessera-url
      (let ((author (get-author)))
        (commit-changes)
        (dynamic-wind
          (lambda ()
            (set! tessera-listening #f)
            (set-author tessera-author))
          (lambda ()
            (patch-inplace-apply (tessera-body) patch)
            (commit-changes))
          (lambda ()
            (set-author author)
            (set! tessera-listening #t))))))

  (define (tessera-receive source)
    (let* ((remote (tessera-read source))
           (local (patch-compound (reverse tessera-pending)))
           (base tessera-base))
      (and (patch-applicable? remote base)
           (let ((next (patch-apply base remote)))
             (if (not (patch-modifies? local))
                 (and (patch-applicable? remote (tessera-body))
                      (begin (tessera-apply-remote remote)
                             (set! tessera-base next) #t))
                 (let ((inverse (patch-invert remote base)))
                   (and (patch-can-pull? local inverse)
                        (let* ((pulled (patch-pull local inverse))
                               (back (patch-co-pull local inverse)))
                          (and (patch-applicable? pulled next)
                               (let ((merged (patch-apply next pulled)))
                                 (and (patch-applicable? back merged)
                                      (equal? (tree->stree (patch-apply merged back))
                                              (tree->stree (tessera-body)))
                                      (begin
                                        (tessera-apply-remote (patch-invert back merged))
                                        (set! tessera-pending (list pulled))
                                        (set! tessera-base next) #t))))))))))))
)
`;
