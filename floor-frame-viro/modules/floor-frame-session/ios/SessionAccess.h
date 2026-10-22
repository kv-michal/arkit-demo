#import <UIKit/UIKit.h>
#import <ARKit/ARKit.h>

NS_ASSUME_NONNULL_BEGIN
/// Accesses Viro's session; never creates a second camera or renderer.
@interface FFSessionAccess : NSObject
+ (nullable ARSession *)currentSession;
@end
NS_ASSUME_NONNULL_END
