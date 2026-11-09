;; Record native modifications for the browser integration test.
(define workbench-observer #f)
(define workbench-pending '())
(define workbench-body #f)

(define (workbench-notify event target modification)
  (when (and (eq? event 'announce)
             (not (eq? (modification-type modification) 'set-cursor)))
    (let ((change (modification-copy modification)))
      (set! workbench-pending
        (cons (patch-pair change (modification-invert change target))
              workbench-pending)))))

(define (workbench-observe)
  (set! workbench-body (buffer-get-body (current-buffer-url)))
  (set! workbench-pending '())
  (set! workbench-observer (tree-observe workbench-body "workbench-notify"))
  (tree-copy workbench-body))

(define (workbench-replay! target)
  (let ((patch (patch-compound (reverse workbench-pending))))
    (and (patch-modifies? patch)
         (patch-applicable? patch target)
         (begin
           (patch-inplace-apply target patch)
           (equal? (tree->stree target) (tree->stree workbench-body))))))
